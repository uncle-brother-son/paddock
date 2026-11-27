import 'server-only'
import type { z } from 'zod'
import type { ApiFailure, ApiSuccess, CustomerContext, StaffContext } from '@/contracts'
import { authenticateCustomer, authenticateSignIn, type SignInIdentity, type SignInVerifier, type TokenVerifier } from '@/server/auth/customer'
import { authenticateStaff, authenticateStaffSignIn, requireAdmin, requireIssueRefunds, requireManagePricing } from '@/server/auth/staff'
import type { Db } from '@/server/db'
import { ApiError, toApiError, validationError } from './errors'
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  hashRequest,
  readIdempotencyKey,
  type IdempotencyScope,
  type StoredResponse,
} from './idempotency'
import { redactForLog, type RequestLogEntry } from './log'
import { resolveRequestId } from './request-id'

/**
 * Who a route answers. `staff`: an active staff member (the shared key, the signed-in email, its staff row, active).
 * `staff_sign_in` (W49, lead call L10; W48 "Noticed" 4): the shared key and the signed-in email only, with no staff
 * row asked for. It exists for one route, `GET /api/v1/staff/staff/me`, which answers an inactive member's own row
 * so the screen can say so; the handler gets the email and nothing else.
 *
 * W54a (W49 + W54 review F3): such a route can only be a read. The type stopped it being `idempotent`, but nothing
 * stopped a plain POST copying `staff/me`'s config, which would then run for an inactive member. Now its config must
 * say `method: 'GET'`; anything else is thrown when the route is defined (so the build and every test that loads the
 * route fail), and the route refuses any request that isn't a GET before it reads anything, so the config can't be
 * exported under another verb either.
 *
 * `customer_sign_in` (W85a, backend log 9): a signed-in website login that may have no customer yet (`customer` needs
 * one, and answers CUSTOMER_NOT_LINKED without it). The handler gets the login's id and its confirmed email, from the
 * token (`authenticateSignIn`), never from the request. Only the sign-in routes use it (link, create): each is safe
 * to call twice by what it does (a linked login answers as linked), so it takes no Idempotency-Key.
 */
export type AuthMode = 'staff' | 'staff_sign_in' | 'customer' | 'customer_sign_in' | 'public'
export type Permission = 'admin' | 'issueRefunds' | 'managePricing'

export type RouteConfig<A extends AuthMode, I extends z.ZodType, O extends z.ZodType> = {
  auth: A
  input: I
  output: O
  /** Requires an Idempotency-Key header and runs at most once per key. Set on every write. */
  idempotent?: boolean
} & (A extends 'staff' ? { permission?: Permission } : { permission?: never }) &
  (A extends 'staff_sign_in' ? { idempotent?: never; method: 'GET' } : object) &
  (A extends 'customer_sign_in' ? { idempotent?: never } : object)

/** W54a (F3): what a `staff_sign_in` route's config must say, checked when the route is defined. */
function requireSignInRouteIsARead(config: { auth: AuthMode; idempotent?: unknown; method?: unknown }): void {
  // W85a: a login with no customer has no idempotency scope; its routes are safe twice by what they do.
  if (config.auth === 'customer_sign_in' && config.idempotent) {
    throw new Error("A 'customer_sign_in' route can't be idempotent: it must be safe to call twice by what it does.")
  }
  if (config.auth !== 'staff_sign_in') return
  if (config.method !== 'GET' || config.idempotent) {
    throw new Error("A 'staff_sign_in' route answers an inactive or unknown sign-in, so it can only be a read: its config must say method: 'GET' and can never be idempotent.")
  }
}

type ActorFor<A extends AuthMode> = A extends 'staff'
  ? { staff: StaffContext }
  : A extends 'staff_sign_in'
    ? { signIn: { email: string } }
    : A extends 'customer'
      ? { customer: CustomerContext }
      : A extends 'customer_sign_in'
        ? { login: SignInIdentity }
        : object

export type RouteContext<A extends AuthMode, I extends z.ZodType> = {
  input: z.output<I>
  db: Db
  requestId: string
  /** The request's Idempotency-Key on an idempotent route. Stripe keys never use it: see stripeIdempotencyKey. */
  idempotencyKey: string | null
  request: Request
  /** When the request started (ms since the epoch, from the route's clock): the order's deadline counts from it (W10a). */
  startedAt: number
} & ActorFor<A>

export interface NextRouteContext {
  params?: Promise<Record<string, string | string[] | undefined>>
}

export type RouteHandler = (request: Request, context?: NextRouteContext) => Promise<Response>

export interface RouteDeps {
  openDb(): Db
  closeDb(db: Db): Promise<void> | void
  staffApiKey(): string | undefined
  tokenVerifier(): TokenVerifier
  /** W85a: the sign-in routes' check (the token, then the login's confirmed email from Supabase). */
  signInVerifier(): SignInVerifier
  log(entry: RequestLogEntry): void
  now(): number
  /** Output is checked in development and tests only, to keep production fast. */
  validateOutput: boolean
}

interface Result extends StoredResponse {
  errorCode: string | null
  errorDetail?: string
  replayed?: boolean
}

function failure(err: unknown, requestId: string): Result {
  const error = toApiError(err)
  const body: ApiFailure = { ok: false, error: error.toBody(), requestId }
  return {
    status: error.status,
    body,
    errorCode: error.code,
    ...(error.logDetail !== undefined ? { errorDetail: redactForLog(error.logDetail) } : {}),
  }
}

/** The query string, then the JSON body, then the path parameters, as one object for zod. */
async function readInput(request: Request, context: NextRouteContext | undefined): Promise<Record<string, unknown>> {
  const { searchParams } = new URL(request.url)
  const query = Object.fromEntries(
    Array.from(new Set(searchParams.keys()), (key) => {
      const values = searchParams.getAll(key)
      return [key, values.length > 1 ? values : values[0]]
    })
  )

  let body: object = {}
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text()
    if (text.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new ApiError('VALIDATION', 'The request body is not valid JSON.')
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ApiError('VALIDATION', 'The request body must be a JSON object.')
      }
      body = parsed
    }
  }

  return { ...query, ...body, ...(await context?.params) }
}

function checkPermission(permission: Permission | undefined, staff: StaffContext): void {
  if (permission === 'admin') requireAdmin(staff)
  if (permission === 'issueRefunds') requireIssueRefunds(staff)
  if (permission === 'managePricing') requireManagePricing(staff)
}

/**
 * Builds defineRoute around its dependencies, so tests can run the whole path with fakes.
 * The production one is in define-route.ts.
 */
export function createRouteFactory(deps: RouteDeps) {
  return function defineRoute<A extends AuthMode, I extends z.ZodType, O extends z.ZodType>(
    config: RouteConfig<A, I, O>,
    handler: (context: RouteContext<A, I>) => Promise<z.output<O>>
  ): RouteHandler {
    requireSignInRouteIsARead(config)
    return async function route(request, nextContext) {
      const startedAt = deps.now()
      const requestId = resolveRequestId(request.headers)
      const path = new URL(request.url).pathname
      let actor: string | null = null
      let db: Db | null = null
      let result: Result

      const run = async (context: RouteContext<A, I>): Promise<Result> => {
        try {
          const data = await handler(context)
          if (deps.validateOutput) {
            const checked = config.output.safeParse(data)
            if (!checked.success) {
              throw new Error(`Response doesn't match its contract: ${checked.error.message}`)
            }
          }
          const body: ApiSuccess<unknown> = { ok: true, data, requestId }
          return { status: 200, body, errorCode: null }
        } catch (err) {
          return failure(err, requestId)
        }
      }

      try {
        db = deps.openDb()
        const openDb = db

        let identity: { staff: StaffContext } | { signIn: { email: string } } | { customer: CustomerContext } | { login: SignInIdentity } | object = {}
        let scopeActor: Pick<IdempotencyScope, 'actorType' | 'actorId'> = { actorType: 'public', actorId: 'public' }
        if (config.auth === 'staff') {
          const staff = await authenticateStaff(request.headers, openDb, deps.staffApiKey())
          identity = { staff }
          scopeActor = { actorType: 'staff', actorId: staff.id }
          actor = `staff:${staff.id}`
          checkPermission(config.permission, staff)
        } else if (config.auth === 'staff_sign_in') {
          // W49 (L10): the key and the signed-in email, and no staff row. The log names no one: there may be no row.
          const email = await authenticateStaffSignIn(request.headers, deps.staffApiKey())
          actor = 'staff_sign_in'
          // W54a (F3): a read only, whatever verb the handler was exported under. Refused before the handler runs.
          if (request.method !== 'GET') throw new ApiError('FORBIDDEN', 'This route only reads: it answers a GET and nothing else.')
          identity = { signIn: { email } }
        } else if (config.auth === 'customer') {
          const customer = await authenticateCustomer(request.headers, openDb, deps.tokenVerifier())
          identity = { customer }
          scopeActor = { actorType: 'customer', actorId: customer.customerId }
          actor = `customer:${customer.customerId}`
        } else if (config.auth === 'customer_sign_in') {
          // W85a: the login, which may have no customer yet. The log names the login, not an email.
          const login = await authenticateSignIn(request.headers, deps.signInVerifier())
          identity = { login }
          actor = `login:${login.authUserId}`
        } else {
          actor = 'public'
        }

        const rawInput = await readInput(request, nextContext)
        const parsed = config.input.safeParse(rawInput)
        if (!parsed.success) throw validationError(parsed.error)

        const idempotencyKey = config.idempotent ? readIdempotencyKey(request.headers) : null
        const context = {
          input: parsed.data,
          db: openDb,
          requestId,
          idempotencyKey,
          request,
          startedAt,
          ...identity,
        } as RouteContext<A, I>

        if (idempotencyKey === null) {
          result = await run(context)
        } else {
          const scope: IdempotencyScope = {
            ...scopeActor,
            endpoint: `${request.method} ${path}`,
            key: idempotencyKey,
          }
          const stored = await claimIdempotencyKey(openDb, scope, await hashRequest(rawInput))
          if (stored) {
            result = { ...stored, errorCode: null, replayed: true }
          } else {
            result = await run(context)
            try {
              // W14 (W13c review L1): in a transaction, so the statement_timeout (8 s) bounds it, lock wait
              // included, rather than only the client's 10 s query limit. The convention counts it at 8.1 s.
              const response = { status: result.status, body: result.body }
              await openDb.transaction((tx) => completeIdempotencyKey(tx, scope, response))
            } catch (err) {
              // The work is done, so report it. The key stays 'in_progress': a retry gets CONFLICT
              // rather than running the handler again.
              const detail = err instanceof Error ? err.message : String(err)
              const stored = redactForLog(`Could not store the idempotent response: ${detail}`)
              result.errorDetail = result.errorDetail ? `${result.errorDetail} | ${stored}` : stored
            }
          }
        }
      } catch (err) {
        result = failure(err, requestId)
      }

      if (db) {
        try {
          await deps.closeDb(db)
        } catch {
          // The response is already decided, and the runtime drops the sockets with the request.
        }
      }

      deps.log({
        event: 'api_request',
        requestId,
        route: path,
        method: request.method,
        actor,
        status: result.status,
        durationMs: Math.round(deps.now() - startedAt),
        errorCode: result.errorCode,
        ...(result.errorDetail !== undefined ? { errorDetail: result.errorDetail } : {}),
      })

      return Response.json(result.body, {
        status: result.status,
        headers: {
          'X-Request-Id': requestId,
          'Cache-Control': 'no-store',
          ...(result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
        },
      })
    }
  }
}
