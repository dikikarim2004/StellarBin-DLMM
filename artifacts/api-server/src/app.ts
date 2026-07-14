import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import pinoHttpImport from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

// Some TypeScript/module-resolution setups (e.g. Vercel's own build-time
// type-check) resolve pino-http's CJS `export =` typings without a callable
// default export. Cast explicitly so this stays correct regardless of the
// resolving toolchain's interop settings.
const pinoHttp = pinoHttpImport as unknown as (options: Record<string, unknown>) => RequestHandler;

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: { id?: unknown; method?: string; url?: string }) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: { statusCode?: number }) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
