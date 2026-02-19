import { NextResponse } from "next/server";

type DoctorRequest = {
  question?: string;
  context?: unknown;
};

type DoctorContext = {
  mode?: string;
  patient?: {
    title?: string;
    bestAlternative?: string;
    appropriate?: string[];
    teachingPoint?: string;
  };
  selectedDrug?: {
    id?: string;
    name?: string;
  } | null;
  feedback?: {
    score?: number;
    headline?: string;
  } | null;
};

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODELS = [
  "gpt-4.1-mini",
  "gpt-4o-mini",
] as const;

function extractOpenAIText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;

  const outputText = (data as { output_text?: unknown }).output_text;
  if (typeof outputText === "string" && outputText.trim().length > 0) {
    return outputText.trim();
  }

  const chunks: string[] = [];
  const output = (data as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const textValue = (part as { text?: unknown }).text;
      if (typeof textValue === "string" && textValue.trim().length > 0) {
        chunks.push(textValue.trim());
      }

      const nestedText = (part as { text?: { value?: unknown } }).text?.value;
      if (typeof nestedText === "string" && nestedText.trim().length > 0) {
        chunks.push(nestedText.trim());
      }

      const text = (part as { text?: unknown }).text;
      if (text && typeof text === "object") {
        const value = (text as { value?: unknown }).value;
        if (typeof value === "string" && value.trim().length > 0) {
          chunks.push(value.trim());
        }
      }
    }
  }

  return chunks.length > 0 ? chunks.join("\n\n") : null;
}

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_api_key_here") {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY on server." },
      { status: 500 }
    );
  }

  let body: DoctorRequest;
  try {
    body = (await req.json()) as DoctorRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const question = body.question?.trim();
  if (!question) {
    return NextResponse.json({ error: "Question is required." }, { status: 400 });
  }

  const context = (body.context ?? {}) as DoctorContext;
  const contextText = JSON.stringify(body.context ?? {}, null, 2);
  const testingAnswerKey =
    context.mode === "testing"
      ? buildTestingAnswerKey(context)
      : null;

  const systemInstruction =
    "You are an educational AI Doctor tutor for a diabetes medication simulator. " +
    "Only respond to what the student explicitly asks. " +
    "Give a direct answer and explain why it is correct using the provided case context. " +
    "If the student shares their choice/reasoning, provide concise feedback: what is correct, what is incorrect, and why. " +
    "In testing mode, use the provided patient answer key as ground truth for correctness and reasoning." +
    "Use only the provided simulator context. If unsure, say what is uncertain. " +
    "Do not provide definitive diagnosis or treatment directives for real patients. " +
    "Always include a short safety reminder that this is educational and requires clinician verification.";

  const userPrompt =
    `Student question:\n${question}\n\n` +
    `Simulator context:\n${contextText}\n\n` +
    (testingAnswerKey ? `Testing answer key:\n${testingAnswerKey}\n\n` : "") +
    "Reply in plain language and stay scoped to the student's request. " +
    "When relevant, state the best medication class and the clinical reasoning for it.";

  try {
    const errors: string[] = [];
    const configuredModel = process.env.OPENAI_MODEL?.trim();
    const models = configuredModel
      ? ([configuredModel, ...OPENAI_MODELS.filter((m) => m !== configuredModel)] as const)
      : OPENAI_MODELS;

    for (const model of models) {
      const resp = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          instructions: systemInstruction,
          input: userPrompt,
          max_output_tokens: 350,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        errors.push(`${model}: ${errText}`);
        continue;
      }

      const data = (await resp.json()) as unknown;
      const answer = extractOpenAIText(data);
      if (answer) {
        return NextResponse.json({ answer });
      }

      errors.push(`${model}: No response text returned by model.`);
    }

    return NextResponse.json(
      {
        error: "Model request failed.",
        detail: errors.length > 0 ? errors.join(" | ") : "No model attempts were made.",
      },
      { status: 502 }
    );
  } catch {
    return NextResponse.json(
      { error: "Unexpected error while generating AI Doctor response." },
      { status: 500 }
    );
  }
}

function buildTestingAnswerKey(context: DoctorContext): string {
  const patientTitle = context.patient?.title?.trim() || "Current patient";
  const best = context.patient?.bestAlternative?.trim() || "unknown";
  const appropriate = Array.isArray(context.patient?.appropriate)
    ? context.patient?.appropriate.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];
  const teachingPoint = context.patient?.teachingPoint?.trim() || "No teaching point provided.";
  const selectedDrug = context.selectedDrug?.name || context.selectedDrug?.id || "No drug selected";

  return (
    `Patient: ${patientTitle}\n` +
    `Best medication class: ${best}\n` +
    `Other appropriate options: ${appropriate.length > 0 ? appropriate.join(", ") : "None listed"}\n` +
    `Student selected: ${selectedDrug}\n` +
    `Core reasoning: ${teachingPoint}`
  );
}
