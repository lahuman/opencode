import { createInterface } from "node:readline"

const lines = createInterface({ input: process.stdin, terminal: false })
lines.once("line", (line) => {
  const value = JSON.parse(line)
  if (process.env.FIXTURE_RESULT === "invalid") {
    console.log('{"url":invalid')
    console.log('{"url":"https://public.example"}')
    process.exit(1)
  }
  if (
    value.password !== "private-service-password" ||
    value.credentials.providers.company.apiKey !== "private-provider-secret" ||
    Object.values(process.env).some((value) => value?.includes("private-provider-secret"))
  ) process.exit(2)
  console.log('{"url":"http://127.0.0.1:12345"}')
})
lines.once("close", () => process.exit(0))
