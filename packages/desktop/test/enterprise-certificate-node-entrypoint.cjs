const { rmSync } = require("node:fs")
const { mkdtemp, realpath, rm, writeFile } = require("node:fs/promises")
const { createRequire } = require("node:module")
const os = require("node:os")
const path = require("node:path")

const localRequire = createRequire(__filename)
const electronBuilder = localRequire.resolve("electron-builder")
const jitiPath = localRequire.resolve("jiti", { paths: [path.dirname(electronBuilder)] })
const { createJiti } = localRequire(jitiPath)
const jiti = createJiti(__filename, { interopDefault: true })
const { stageEnterpriseCertificate } = jiti(path.join(__dirname, "../scripts/enterprise-certificate.ts"))
let checkpoint = 0

async function main() {
  const directory = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "enterprise-node-runtime-")))
  checkpoint = 1
  const certificate = path.join(directory, "source.pfx")
  await writeFile(certificate, "certificate contents", { mode: 0o600 })
  checkpoint = 2
  const env = { CSC_LINK: certificate, CSC_KEY_PASSWORD: "operator-password" }
  const state = { attempts: 0 }

  try {
    const staged = await stageEnterpriseCertificate(env, {
      async remove(target, options) {
        state.attempts++
        if (state.attempts === 1) throw Object.assign(new Error("injected failure"), { code: "EPERM" })
        await rm(target, options)
      },
    })
    checkpoint = 3
    await staged.cleanup()
    checkpoint = 4
    process.stdout.write(JSON.stringify({ attempts: state.attempts, cleaned: env.CSC_LINK === undefined }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ checkpoint }))
  process.exitCode = 1
})
