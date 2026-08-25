// Hutch config for the FreeLLMAPI desktop app. This app is a dual shell:
// the Electrobun (Bun) build under eb/ and the legacy Electron build under src/.
// Keep npm as the package manager so the existing desktop/package-lock.json
// stays authoritative (Hutch's built-in resolver would otherwise write hutch.lock).
export default {
  packageManager: "npm",
};
