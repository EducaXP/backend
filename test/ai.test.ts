import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlanningAgent, readAIConfig, type AIConfig } from "../src/ai.js";
import { planningTemplate } from "../src/planning.js";
import { ApiError } from "../src/domain.js";

const config: AIConfig = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "fixture/model",
  apiKey: "test-only-key",
};
const context = {
  instruction: "Crie uma atividade sobre descontos.",
  subject: "Matemática",
  schoolYear: "9º ano",
  durationMinutes: 30,
  resources: "Papel e um celular por equipe",
  history: [{ role: "user" as const, content: "Priorize colaboração." }],
  currentDraft: planningTemplate({
    theme: "descontos",
    subject: "Matemática",
    schoolYear: "9º ano",
    durationMinutes: 30,
  }),
};
const proposal = {
  reply: "Proposta fictícia. Revisão curricular pendente.",
  content: {
    ...context.currentDraft,
    questions: [
      {
        id: "q1",
        topic: "Porcentagem",
        prompt:
          "Um produto custa R$ 100 e tem 20% de desconto. Qual é o preço final? Expliquem o cálculo.",
      },
      {
        id: "q2",
        topic: "Comparação",
        prompt: "Que evidência vocês usariam para escolher entre duas ofertas?",
      },
    ],
  },
};
const envelope = (value: unknown = proposal) => ({
  choices: [
    { finish_reason: "stop", message: { content: JSON.stringify(value) } },
  ],
});
const fake =
  (response: () => Response): typeof fetch =>
  async () =>
    response();
const rejectsCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, code);
  assert.ok(!error.message.includes(config.apiKey));
  assert.ok(!error.message.includes(context.instruction));
  return true;
};

test("IA configura provedor/modelo sem chave padrão e rejeita URL ambígua", () => {
  assert.equal(readAIConfig({}), undefined);
  assert.equal(createPlanningAgent(undefined), undefined);
  const env = { AI_API_KEY: config.apiKey, AI_MODEL: config.model };
  assert.deepEqual(readAIConfig(env), config);
  assert.equal(
    readAIConfig({
      ...env,
      AI_PROVIDER: "compatible",
      AI_BASE_URL: "https://provider.example/v1/",
    })?.baseUrl,
    "https://provider.example/v1",
  );
  for (const patch of [
    { AI_MODEL: "" },
    { AI_PROVIDER: "unknown" },
    { AI_BASE_URL: "http://provider.example/v1" },
    { AI_BASE_URL: "https://key@provider.example/v1" },
    { AI_BASE_URL: "https://provider.example/v1?key=secret" },
    { AI_BASE_URL: "https://provider.example/v1#frag" },
    { AI_BASE_URL: "invalid" },
    { AI_PROVIDER: "compatible" },
  ]) {
    assert.throws(() => readAIConfig({ ...env, ...patch }));
  }
});

test("IA envia apenas contexto aprovado, autentica no cabeçalho e exige JSON estruturado", async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer " + config.apiKey,
    );
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model);
    assert.equal(body.max_tokens, 6000);
    assert.equal(body.stream, false);
    assert.deepEqual(body.provider, {
      require_parameters: true,
      data_collection: "deny",
    });
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.messages.length, 2);
    assert.deepEqual(JSON.parse(body.messages[1].content), context);
    assert.ok(!String(init?.body).includes(config.apiKey));
    assert.equal(body.tools, undefined);
    return Response.json(envelope());
  };
  assert.deepEqual(
    await createPlanningAgent(config, transport)!(
      context,
      new AbortController().signal,
    ),
    proposal,
  );
  assert.equal(calls, 1);
});

test("IA permite API compatível sem enviar parâmetros exclusivos do OpenRouter", async () => {
  const transport: typeof fetch = async (url, init) => {
    assert.equal(url, "https://provider.example/v1/chat/completions");
    assert.equal(JSON.parse(String(init?.body)).provider, undefined);
    return Response.json(envelope());
  };
  await createPlanningAgent(
    {
      ...config,
      provider: "compatible",
      baseUrl: "https://provider.example/v1",
    },
    transport,
  )!(context, new AbortController().signal);
});

test("IA trata falhas sem propagar dados sensíveis e sem repetição automática de custo", async () => {
  for (const [status, code] of [
    [401, "AI_CONFIGURATION_ERROR"],
    [403, "AI_CONFIGURATION_ERROR"],
    [402, "AI_CREDITS_REQUIRED"],
    [429, "AI_PROVIDER_BUSY"],
    [400, "AI_MODEL_UNAVAILABLE"],
    [404, "AI_MODEL_UNAVAILABLE"],
    [500, "AI_UNAVAILABLE"],
  ] as const) {
    let calls = 0;
    const agent = createPlanningAgent(
      config,
      fake(() => {
        calls++;
        return new Response(config.apiKey + context.instruction, { status });
      }),
    )!;
    await assert.rejects(
      agent(context, new AbortController().signal),
      rejectsCode(code),
    );
    assert.equal(calls, 1);
  }
  const transport: typeof fetch = async () => {
    throw new Error(config.apiKey + context.instruction);
  };
  await assert.rejects(
    createPlanningAgent(config, transport)!(
      context,
      new AbortController().signal,
    ),
    rejectsCode("AI_UNAVAILABLE"),
  );
});

test("IA recusa JSON inválido, recusas, truncamento e respostas grandes ou sem estrutura pedagógica", async () => {
  const responses = [
    () => new Response("not JSON"),
    () => Response.json({ error: { message: config.apiKey } }),
    () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: JSON.stringify(proposal) },
          },
        ],
      }),
    () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { refusal: "recusa", content: JSON.stringify(proposal) },
          },
        ],
      }),
    () => Response.json(envelope({ reply: "Incompleto", content: {} })),
    () => new Response("x".repeat(128 * 1024 + 1)),
  ];
  for (const response of responses)
    await assert.rejects(
      createPlanningAgent(config, fake(response))!(
        context,
        new AbortController().signal,
      ),
      rejectsCode("AI_INVALID_RESPONSE"),
    );
});

test("IA cancela transporte ao receber sinal de timeout e não inicia chamada já cancelada", async () => {
  const controller = new AbortController();
  let called = false;
  const transport: typeof fetch = async (_url, init) => {
    called = true;
    assert.equal(init?.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("cancelled")),
        { once: true },
      );
      controller.abort();
    });
  };
  await assert.rejects(
    createPlanningAgent(config, transport)!(context, controller.signal),
    rejectsCode("AI_TIMEOUT"),
  );
  assert.equal(called, true);
  called = false;
  await assert.rejects(
    createPlanningAgent(config, transport)!(context, controller.signal),
    rejectsCode("AI_TIMEOUT"),
  );
  assert.equal(called, false);
});
