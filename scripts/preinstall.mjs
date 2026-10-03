import { rm } from "node:fs/promises";

if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exitCode = 1;
} else {
  await Promise.all([
    rm("package-lock.json", { force: true }),
    rm("yarn.lock", { force: true }),
  ]);
}