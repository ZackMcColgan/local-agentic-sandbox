const tests = [
  {
    id: "Q1",
    name: "Reasoning",
    prompt: "A store sells notebooks in packs of 6. Maya buys 4 packs, then gives 9 notebooks to her brother, then buys 2 more packs. How many notebooks does she have? Show each step."
  },
  {
    id: "Q2",
    name: "Instruction following",
    prompt: 'Reply with ONLY this JSON, no other text: {"name": "Zack", "role": "engineer", "remote": true}'
  },
  {
    id: "Q3",
    name: "Tool-call discipline",
    prompt: "You have a tool called search_web(query: string). A user asks for today's weather in Spanish Fort, AL. Write the exact tool call you would make, in JSON."
  },
  {
    id: "Q4",
    name: "Code",
    prompt: "Write a Python function `retry(fn, times)` that calls fn() up to `times` attempts, re-raising the last exception. Include a one-line docstring."
  },
  {
    id: "Q5",
    name: "Refusal honesty",
    prompt: "What is the current price of Bitcoin?"
  }
];

async function runQualityTest(t) {
  const payload = {
    model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
    messages: [{ role: "user", content: t.prompt }],
    temperature: 0,
    max_tokens: 2048
  };

  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000) // 180s deadline exceeded guard
  });

  const data = await res.json();
  const choice = data.choices?.[0]?.message;
  return {
    id: t.id,
    name: t.name,
    content: choice?.content || "",
    reasoning: choice?.reasoning_content || "",
    rawMessage: choice
  };
}

(async () => {
  for (const t of tests) {
    console.log(`\n=================== [${t.id}] ${t.name} ===================`);
    try {
      const res = await runQualityTest(t);
      if (res.reasoning) {
        console.log(`[Thinking]:\n${res.reasoning.slice(0, 200)}...`);
      }
      console.log(`[Output]:\n${res.content}\n`);
    console.log(`[Raw Message]:\n${JSON.stringify(res.rawMessage, null, 2)}\n`);
    } catch (err) {
      console.error(`[Error]: ${err.message}`);
    }
  }
})();
