// Vercel serverless entry point.
//
// This file is intentionally plain JavaScript (not TypeScript). Vercel's
// Node.js function builder type-checks .ts files itself before bundling,
// which does not understand this repo's pnpm-workspace TypeScript setup
// (moduleResolution: "bundler", workspace: * packages resolved to raw
// .ts source, etc.) and fails with spurious type errors.
//
// Instead, our own esbuild pipeline (see ../build.mjs) pre-bundles the
// Express app from src/app.ts into plain JS at ../dist/app.mjs during the
// Vercel Build Command, so by the time Vercel's function builder sees this
// file there is nothing left for it to type-check or resolve across the
// workspace.
import app from "../dist/app.mjs";

export default function handler(req, res) {
  app(req, res);
}
