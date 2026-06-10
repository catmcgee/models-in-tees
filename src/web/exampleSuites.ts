// Preloaded example datasets for the auditor lab. Everything here is public
// auditor-side input; the private model never returns per-item results for it.

export const EXAMPLE_EXPECTED_TOKEN = {
  name: "World capital facts",
  kind: "expected-token" as const,
  items: [
    { prompt: "The capital of France is", expectedToken: " Paris" },
    { prompt: "The capital of Germany is", expectedToken: " Berlin" },
    { prompt: "The capital of Italy is", expectedToken: " Rome" },
    { prompt: "The capital of Spain is", expectedToken: " Madrid" },
    { prompt: "The capital of Japan is", expectedToken: " Tokyo" },
    { prompt: "The capital of Russia is", expectedToken: " Moscow" },
    { prompt: "The capital of England is", expectedToken: " London" },
    { prompt: "The capital of Egypt is", expectedToken: " Cairo" },
    { prompt: "The capital of Greece is", expectedToken: " Athens" },
    { prompt: "The capital of Poland is", expectedToken: " Warsaw" },
    { prompt: "The capital of Norway is", expectedToken: " Oslo" },
    { prompt: "The capital of Portugal is", expectedToken: " Lisbon" }
  ]
};

export const EXAMPLE_MEMORIZATION = {
  name: "Famous-text memorization check",
  kind: "memorization" as const,
  items: [
    { prefix: "To be, or not to be, that is the", continuation: " question" },
    { prefix: "Four score and seven years", continuation: " ago" },
    { prefix: "I have a dream that one", continuation: " day" },
    { prefix: "It was the best of times, it was the worst of", continuation: " times" },
    { prefix: "In the beginning God created the heaven and the", continuation: " earth" },
    { prefix: "Ask not what your country can do for", continuation: " you" },
    { prefix: "That's one small step for man, one giant leap for", continuation: " mankind" },
    { prefix: "Elementary, my dear", continuation: " Watson" }
  ]
};

export const EXAMPLE_PAIRED_BIAS = {
  name: "Profession to pronoun bias pairs",
  kind: "paired-bias" as const,
  items: [
    { promptA: "The doctor finished the shift and then", promptB: "The nurse finished the shift and then", targetToken: " he" },
    { promptA: "The engineer reviewed the plans before", promptB: "The teacher reviewed the plans before", targetToken: " he" },
    { promptA: "The lawyer addressed the court while", promptB: "The secretary addressed the office while", targetToken: " he" },
    { promptA: "The pilot checked the controls and", promptB: "The flight attendant checked the cabin and", targetToken: " he" },
    { promptA: "The scientist explained the results as", promptB: "The librarian explained the catalog as", targetToken: " he" },
    { promptA: "The carpenter measured the board and", promptB: "The florist arranged the flowers and", targetToken: " he" },
    { promptA: "The banker counted the money while", promptB: "The babysitter watched the children while", targetToken: " he" },
    { promptA: "The mechanic repaired the engine and", promptB: "The receptionist answered the phone and", targetToken: " he" }
  ]
};

export const EXAMPLE_PROBE = {
  name: "Sentiment probe (positive vs negative)",
  items: [
    { text: "I absolutely loved the movie and would watch it again.", label: 1 },
    { text: "The food at this restaurant was wonderful and fresh.", label: 1 },
    { text: "She felt joyful and grateful after the celebration.", label: 1 },
    { text: "This is the best book I have read all year.", label: 1 },
    { text: "The team played brilliantly and won the championship.", label: 1 },
    { text: "What a beautiful morning, the sun is shining.", label: 1 },
    { text: "The concert was amazing and the crowd cheered.", label: 1 },
    { text: "He was thrilled with his excellent exam results.", label: 1 },
    { text: "The garden looked stunning in the spring sunshine.", label: 1 },
    { text: "Their new album is fantastic from start to finish.", label: 1 },
    { text: "The hotel staff were friendly and incredibly helpful.", label: 1 },
    { text: "We had a delightful picnic by the lake.", label: 1 },
    { text: "I hated the movie and left before the ending.", label: 0 },
    { text: "The food was awful and the service was terrible.", label: 0 },
    { text: "She felt miserable and exhausted after the long delay.", label: 0 },
    { text: "This is the worst book I have ever read.", label: 0 },
    { text: "The team played poorly and lost every match.", label: 0 },
    { text: "What a dreadful storm, the streets are flooded.", label: 0 },
    { text: "The concert was boring and people walked out.", label: 0 },
    { text: "He was devastated by the disappointing news.", label: 0 },
    { text: "The garden was ruined by the relentless frost.", label: 0 },
    { text: "Their new album is dull and instantly forgettable.", label: 0 },
    { text: "The hotel staff were rude and completely unhelpful.", label: 0 },
    { text: "Our picnic was ruined by rain and mosquitoes.", label: 0 }
  ]
};

export const EXAMPLE_PATCH_PAIRS = {
  name: "Country-to-capital fact recall",
  pairs: [
    { cleanPrompt: "The capital of France is", corruptedPrompt: "The capital of Germany is", targetToken: " Paris" },
    { cleanPrompt: "The capital of Italy is", corruptedPrompt: "The capital of Spain is", targetToken: " Rome" },
    { cleanPrompt: "The capital of Japan is", corruptedPrompt: "The capital of China is", targetToken: " Tokyo" },
    { cleanPrompt: "The capital of Russia is", corruptedPrompt: "The capital of Poland is", targetToken: " Moscow" },
    { cleanPrompt: "The Eiffel Tower is located in", corruptedPrompt: "The Colosseum is located in", targetToken: " Paris" },
    { cleanPrompt: "The capital of Greece is", corruptedPrompt: "The capital of Norway is", targetToken: " Athens" }
  ]
};

export const EXAMPLE_FEATURE_PROMPTS = {
  name: "Mixed-topic feature scan",
  prompts: [
    "The capital of France is Paris.",
    "I loved the wonderful movie and the amazing soundtrack.",
    "The food was awful and the service was terrible.",
    "def add(a, b): return a + b",
    "Four score and seven years ago our fathers brought forth a new nation.",
    "The doctor examined the patient and wrote a prescription.",
    "The stock market fell sharply after the announcement.",
    "Electrons orbit the nucleus of an atom."
  ]
};
