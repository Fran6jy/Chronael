import { defineConfig, loadEnv, type Plugin } from "vite";
import { requestCoach, type CoachFacts } from "./api/coach";

// Dev-time middleware that exposes POST /api/coach. The OpenRouter key is read from
// the Node process env here (loadEnv with an empty prefix reads ALL vars, not just
// VITE_*), so it stays on the server and is never bundled into the client.
//
// For production, deploy `server/coach.ts` as a serverless function at the same path
// (the client only ever calls /api/coach).
function coachProxy(env: Record<string, string>): Plugin {
  return {
    name: "chronael-coach-proxy",
    configureServer(server) {
      server.middlewares.use("/api/coach", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end("Method Not Allowed");
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", async () => {
          try {
            const facts = JSON.parse(raw || "{}") as CoachFacts;
            const result = await requestCoach(facts, {
              OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
              COACH_MODELS: env.COACH_MODELS,
            });
            res.statusCode = result.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(result.body));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ""); // "" => load all vars, incl. secrets
  return {
    base: "./",
    build: { target: "es2021" },
    plugins: [coachProxy(env)],
  };
});
