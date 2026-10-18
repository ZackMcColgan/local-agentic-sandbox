(async () => {
  const payload = {
    model: "swift-15-27b-mtp",
    messages: [
      {
        role: "user",
        content: "You have a tool called search_web(query: string). A user asks for today's weather in Spanish Fort, AL. Write the exact tool call you would make, in JSON."
      }
    ],
    temperature: 0,
    max_tokens: 2048
  };
  const res = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  console.log("Full Choice:");
  console.log(JSON.stringify(data.choices[0], null, 2));
})();
