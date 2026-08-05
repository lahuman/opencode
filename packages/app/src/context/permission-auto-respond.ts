import { base64Encode } from "@opencode-ai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

export function isExactAutoAccepting(
  autoAccept: Record<string, boolean>,
  sessionID: string,
  directory: string,
) {
  return autoAccept[acceptKey(sessionID, directory)] === true
}

export function mergePermissionSessions<T extends { id: string }>(authoritative: T[], child: T[]) {
  const ids = new Set(authoritative.map((session) => session.id))
  return [...authoritative, ...child.filter((session) => !ids.has(session.id))]
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string; approvalMode?: "ask" | "auto_review" }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  if (session.findLast((item) => item.id === permission.sessionID)?.approvalMode === "auto_review") return false
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}

export async function resolvePendingAutoResponse(input: {
  current: () => boolean
  isPending: () => boolean
  disposed: () => boolean
  ensureLineage: () => Promise<boolean>
  mutation: { pending: () => boolean; idle: () => Promise<void> }
  autoResponds: () => boolean
  respond: () => void
}) {
  if (input.disposed() || !input.current() || !input.isPending()) return
  if (!(await input.ensureLineage())) return

  while (!input.disposed() && input.current() && input.isPending()) {
    await input.mutation.idle()
    if (input.disposed() || !input.current() || !input.isPending()) return
    if (input.mutation.pending()) continue
    if (!input.autoResponds()) return
    input.respond()
    return
  }
}
