/**
 * Formerly declared the runtime globals (paddockData, paddockBackendApi2, User) by hand.
 * They now come from the generated declarations in /backend/resources/ and /backend/user.d.ts,
 * which the local `retool check` and the server typecheck both include. Kept as an empty module
 * so the existing side-effect imports (`import './globals'`) stay valid.
 */
export {}
