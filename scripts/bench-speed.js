async function runBench(runNum) {
  const body = {
    prompt: "Explain why the sky is blue, then write a haiku about it.",
    n_predict: 300,
    temperature: 0,
    cache_prompt: false
  };
  const start = Date.now();
  const res = await fetch("http://127.0.0.1:11434/completion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  const t = data.timings;
  console.log(
    "Run " +
      runNum +
      ": prompt " +
      t.prompt_per_second.toFixed(1) +
      " tok/s, decode " +
      t.predicted_per_second.toFixed(1) +
      " tok/s, n=" +
      t.predicted_n +
      ", elapsed=" +
      (Date.now() - start) +
      "ms"
  );
  return {
    prompt_tok_s: t.prompt_per_second,
    decode_tok_s: t.predicted_per_second,
    n: t.predicted_n
  };
}

(async () => {
  const results = [];
  for (let i = 1; i <= 3; i++) {
    results.push(await runBench(i));
  }
  const sorted = [...results].sort((a, b) => a.decode_tok_s - b.decode_tok_s);
  console.log("\n--- MEDIAN RESULT ---");
  console.log("Prompt: " + sorted[1].prompt_tok_s.toFixed(1) + " tok/s");
  console.log("Decode: " + sorted[1].decode_tok_s.toFixed(1) + " tok/s");
  console.log("n: " + sorted[1].n);
})();
