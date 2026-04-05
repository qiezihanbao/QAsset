import fs from "node:fs"
import path from "node:path"

const version = process.argv[2]
const semverLike = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

if (!version || !semverLike.test(version)) {
  console.error("Usage: node scripts/set-version.mjs <semver>")
  console.error("Example: node scripts/set-version.mjs 0.2.0")
  process.exit(1)
}

const root = process.cwd()

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

function updateJsonVersion(filePath) {
  const data = readJson(filePath)
  data.version = version
  writeJson(filePath, data)
}

updateJsonVersion(path.join(root, "package.json"))
updateJsonVersion(path.join(root, "src-tauri", "tauri.conf.json"))

const lockPath = path.join(root, "package-lock.json")
if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath)
  lock.version = version
  if (lock.packages && lock.packages[""]) {
    lock.packages[""].version = version
  }
  writeJson(lockPath, lock)
}

const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml")
const cargoToml = fs.readFileSync(cargoTomlPath, "utf8")
const packageHeader = "[package]"
const packageStart = cargoToml.indexOf(packageHeader)
if (packageStart < 0) {
  console.error("Failed to find [package] block in src-tauri/Cargo.toml")
  process.exit(1)
}

const nextSectionStart = cargoToml.indexOf("\n[", packageStart + packageHeader.length)
const packageBlockEnd = nextSectionStart >= 0 ? nextSectionStart : cargoToml.length
const packageBlock = cargoToml.slice(packageStart, packageBlockEnd)
const versionLinePattern = /^\s*version\s*=\s*"[^"]*"\s*$/m
if (!versionLinePattern.test(packageBlock)) {
  console.error("Failed to update version in src-tauri/Cargo.toml")
  process.exit(1)
}
const updatedPackageBlock = packageBlock.replace(
  versionLinePattern,
  `version = "${version}"`
)

const nextCargoToml =
  cargoToml.slice(0, packageStart) +
  updatedPackageBlock +
  cargoToml.slice(packageBlockEnd)

fs.writeFileSync(cargoTomlPath, nextCargoToml, "utf8")
console.log(`Version updated to ${version}`)
