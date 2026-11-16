export interface EvalCase {
  id: string;
  prompt: string;
  expectedSubstring: string;
}

export interface ModelEvalPackInput {
  passBar: number;
  cases: EvalCase[];
  infer: (prompt: string) => Promise<string>;
}

export interface ModelEvalPackResult {
  passed: boolean;
  score: number;
  passedCount: number;
  totalCount: number;
}

export async function runModelEvalPack(input: ModelEvalPackInput): Promise<ModelEvalPackResult> {
  let passedCount = 0;
  for (const c of input.cases) {
    const out = await input.infer(c.prompt);
    if (out.includes(c.expectedSubstring)) {
      passedCount++;
    }
  }
  const totalCount = input.cases.length;
  const score = totalCount > 0 ? passedCount / totalCount : 0;
  return {
    passed: score >= input.passBar,
    score,
    passedCount,
    totalCount,
  };
}
