// Local only. A stand-in for Jev's documented API, so a `wrangler dev` server can run
// the optional check with no key and no third party. Point a checkout at it with
//   CLOUDYSUITE_LOCAL_JEV_API=http://localhost:9911
// in `.dev.vars`, and start it with
//   bun apps/mail/scripts/fake-jev.mjs [port]
// It answers yes when the message's text has the last word of the question's
// description, or the words FAKE-JEV-SPAM for the spam question. A key of
// "rejected-key" gets a 401.
//   POST /__mode {"mode": "..."}  ok, yes, no, 429, 529, 500, hang, stall,
//                                 malformed, oversized, wrong-shape
//   GET  /__log                   every request since the last reset, without its key
//   POST /__reset                 clears the log and goes back to ok
const port = Number(process.argv[2] ?? 9911);
let mode = "ok";
let log = [];

const NEVER = new Promise(() => {});

function problemWith(body) {
  const missing = ["model", "state", "questions"].filter(
    (field) => body?.[field] === undefined,
  );
  if (missing.length > 0) return `missing: ${missing.join(", ")}`;
  const questions = Object.entries(body.questions);
  if (questions.length === 0) return "questions: at least one";
  for (const [id, question] of questions) {
    if (question.type !== "noul") return `questions.${id}: only noul is faked`;
  }
  return null;
}

function probability(id, question, state) {
  if (mode === "yes") return 0.99;
  if (mode === "no") return 0.01;
  const text = JSON.stringify(state).toLowerCase();
  if (id === "spam") return text.includes("fake-jev-spam") ? 0.97 : 0.02;
  const word = String(question.instructions?.description ?? "")
    .toLowerCase()
    .split(/\s+/)
    .at(-1);
  return word && text.includes(word) ? 0.95 : 0.05;
}

Bun.serve({
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__mode") {
      ({ mode } = await request.json());
      return Response.json({ mode });
    }
    if (url.pathname === "/__log") return Response.json(log);
    if (url.pathname === "/__reset") {
      mode = "ok";
      log = [];
      return Response.json({ ok: true });
    }

    const key = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const text = await request.text();
    const entry = {
      at: Date.now(),
      method: request.method,
      path: url.pathname,
      mode,
      hasKey: Boolean(key),
      body: text ? JSON.parse(text) : null,
    };
    log.push(entry);
    if (!key || key === "rejected-key") {
      return Response.json({ detail: "Invalid API key" }, { status: 401 });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        models: [{ name: "jev-latest", description: "General-purpose." }],
      });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/systemone") {
      return new Response("Not found", { status: 404 });
    }

    const problem = problemWith(entry.body);
    if (problem) return Response.json({ detail: problem }, { status: 422 });
    switch (mode) {
      case "429":
      case "529":
      case "500":
        return Response.json({ detail: mode }, { status: Number(mode) });
      case "hang":
        await NEVER;
        break;
      case "stall":
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"model":'));
            },
            pull: () => NEVER,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      case "malformed":
        return new Response("{not json", {
          headers: { "Content-Type": "application/json" },
        });
      case "oversized":
        return Response.json({
          model: "jev-1.14.0",
          answers: Object.fromEntries(
            Object.keys(entry.body.questions).map((id) => [
              id,
              { type: "noul", noul: 1 },
            ]),
          ),
          usage: { input_tokens: 1, output_tokens: 0 },
          pad: "x".repeat(1024 * 1024),
        });
      case "wrong-shape":
        return Response.json({
          model: "jev-1.14.0",
          answers: { spam: { type: "noul", noul: "yes" } },
          usage: { input_tokens: 1, output_tokens: 0 },
        });
    }
    const { questions, state } = entry.body;
    return Response.json({
      model: "jev-1.14.0",
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          { type: "noul", noul: probability(id, question, state) },
        ]),
      ),
      usage: {
        input_tokens: Math.ceil(text.length / 4),
        output_tokens: Object.keys(questions).length,
      },
    });
  },
});
console.log(`Fake Jev on http://localhost:${port}`);
