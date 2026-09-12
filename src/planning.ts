import type { MissionContent } from "./schemas.js";

export function planningTemplate(input: {
  theme: string;
  subject: string;
  schoolYear: string;
  durationMinutes: number;
}): MissionContent {
  return {
    title: `Investigação colaborativa: ${input.theme}`,
    objective: `Investigar ${input.theme}, comparar explicações e justificar uma conclusão com evidências.`,
    subject: input.subject,
    schoolYear: input.schoolYear,
    durationMinutes: input.durationMinutes,
    offlineAlternative:
      "Distribua as instruções em papel. O grupo pode apresentar sua produção oralmente ou por escrito; o professor registra a síntese da entrega.",
    steps: [
      {
        title: "Combinem os papéis",
        mode: "off_screen",
        instructions:
          "Definam quem organiza, registra e apresenta. Conversem sobre o problema e formulem uma hipótese.",
      },
      {
        title: "Investiguem juntos",
        mode: "off_screen",
        instructions:
          "Usem o material fornecido pelo professor para reunir evidências. Comparem ideias e registrem os argumentos no papel ou no aparelho.",
      },
      {
        title: "Compartilhem a conclusão",
        mode: "screen",
        instructions:
          "Registrem uma síntese com evidências e contem o que mudou na hipótese inicial. A entrega também pode ser mediada pelo professor.",
      },
    ],
    rubric: [
      {
        id: "evidence",
        title: "Uso de evidências",
        levels: [
          "Ainda precisa de apoio para identificar uma evidência.",
          "Apresenta uma evidência, mas precisa explicar sua relação com a conclusão.",
          "Relaciona evidências relevantes à conclusão.",
          "Compara evidências e explica limites da conclusão.",
        ],
      },
      {
        id: "collaboration",
        title: "Construção coletiva",
        levels: [
          "Precisa de apoio para combinar formas de participação.",
          "Participa com apoio e começa a considerar contribuições dos colegas.",
          "Contribui e incorpora ideias dos colegas na produção.",
          "Ajuda a distribuir a participação e a resolver divergências com argumentos.",
        ],
      },
    ],
  };
}
