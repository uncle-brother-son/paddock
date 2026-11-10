import 'server-only'
import type { z } from 'zod'
import type { ApiFailure, ApiSuccess, CustomerContext, StaffContext } from '@/contracts'
import { authenticateCustomer, type TokenVerifier } from '@/server/auth/customer'
import { authenticateStaff, requireAdmin, requireIssueRefunds, requireManagePricing } from '@/server/auth/staff'
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

export type AuthMode = 'staff' | 'customer' | 'public'
export type Permission = 'admin' | 'issueRefunds' | 'managePricing'

export type RouteConfig<A extends AuthMode, I extends z.ZodType, O extends z.ZodType> = {
  auth: A
  input: I
  output: O
  /** Requires an Idempotency-Key header and runs at most once per key. Set on every write. */
  idempotent?: boolean
} & (A extends 'staff' ? { permission?: Permission } : { permission?: never })

type ActorFor<A extends AuthMode> = A extends 'staff'
  ? { staff: StaffContext }
  : A extends 'customer'
    ? { customer: CustomerContext }
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

        let identity: { staff: StaffContext } | { customer: CustomerContext } | object = {}
        let scopeActor: Pick<IdempotencyScope, 'actorType' | 'actorId'> = { actorType: 'public', actorId: 'public' }
        if (config.auth === 'staff') {
          const staff = await authenticateStaff(request.headers, openDb, deps.staffApiKey())
          identity = { staff }
          scopeActor = { actorType: 'staff', actorId: staff.id }
          actor = `staff:${staff.id}`
          checkPermission(config.permission, staff)
        } else if (config.auth === 'customer') {
          const customer = await authenticateCustomer(request.headers, openDb, deps.tokenVerifier())
          identity = { customer }
          scopeActor = { actorType: 'customer', actorId: customer.customerId }
          actor = `customer:${customer.customerId}`
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
              await completeIdempotencyKey(openDb, scope, { status: result.status, body: result.body })
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
