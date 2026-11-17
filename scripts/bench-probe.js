async function probeContext() {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
  let filler = "";
  for (let i = 0; i < 1350; i++) {
    filler += words[i % words.length] + " " + i + " ";
  }
  
  const prompt = "Apple Banana Cantaloupe Date Elderberry.\n\n" + filler + "\n\nReply with ONLY the third word of the first line of this prompt. Do not transcribe or list the filler words.";
  console.log(`Prompt length in chars: ${prompt.length} (~${Math.round(prompt.length / 3.5)} tokens)`);
  
  const payload = {
    model: "Swift-1.5-Qwen3.8-27B-IQ3_XS",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: 1024
  };
  
  const start = Date.now();
  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000) // 180s deadline exceeded guard
  });
  
  const data = await res.json();
  console.log("Status:", res.status);
  if (data.error) {
    console.log("Error:", data.error);
    return;
  }
  const choice = data.choices?.[0]?.message;
  console.log("Elapsed:", Date.now() - start, "ms");
  console.log("Usage:", data.usage);
  if (choice?.reasoning_content) {
    console.log("Reasoning:\n", choice.reasoning_content);
  }
  console.log("Output:\n", choice?.content);
  console.log("Expected: Cantaloupe");
}

probeContext().catch(console.error);
