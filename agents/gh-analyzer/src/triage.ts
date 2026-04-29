import type Anthropic from "@anthropic-ai/sdk";

export type TriagePriority = "critical" | "high" | "medium" | "low";

export function derivePriorityFromLabels(labels: string[]): TriagePriority {
  if (labels.includes("critical")) return "critical";
  if (labels.includes("bug")) return "high";
  if (labels.includes("enhancement")) return "medium";
  if (labels.includes("low")) return "low";
  return "medium";
}

export type TriageInput = { title: string; body: string };
export type TriageOptions = { client: Anthropic; model: string };

const PROMPT = `Você é um analista de triagem. Resuma o problema descrito em PORTUGUÊS, em UM parágrafo curto (3-5 frases). Aponte o que parece ser o sintoma observável e qualquer reprodução mencionada. Não invente detalhes. Não proponha solução.`;

export async function triage(input: TriageInput, opts: TriageOptions): Promise<string> {
  try {
    const res = await opts.client.messages.create({
      model: opts.model,
      max_tokens: 400,
      system: PROMPT,
      messages: [
        {
          role: "user",
          content: `Título: ${input.title}\n\nDescrição:\n${input.body || "(vazio)"}`,
        },
      ],
    });
    const text = res.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return text || "Triagem indisponível: resposta vazia.";
  } catch (err) {
    return `Triagem indisponível: ${(err as Error).message}`;
  }
}
