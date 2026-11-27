import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMemoryAttribution,
  buildMemoryContent,
  formatMemoryContext,
  getPreferenceCategory,
  normalizeMemoryKey,
  normalizeMemoryText,
  normalizeSubject,
  parseMemorySubject,
  planMemoryActions,
  subjectsMatch,
  validateMemoryAttribution
} from "../../src/utils/memory-format.js";

const NOW = new Date("2026-11-25T00:00:00.000Z");

function extracted(overrides = {}) {
  return {
    action: "add",
    replaces_id: null,
    subject: "user",
    memory_type: "preference",
    content: "Prefers Node.js for backend development.",
    duration: "permanent",
    expires_in_days: null,
    confidence: 0.95,
    importance: 4,
    ...overrides
  };
}

test("subject prefix round trip", () => {
  assert.equal(buildMemoryContent("user", "Likes tea."), "Likes tea.");
  assert.equal(buildMemoryContent("User's Sister", "Likes jazz."), "[about: user's sister] Likes jazz.");
  assert.deepEqual(parseMemorySubject("[about: user's sister] Likes jazz."), {
    subject: "user's sister",
    text: "Likes jazz."
  });
  assert.deepEqual(parseMemorySubject("Legacy memory"), { subject: "user", text: "Legacy memory" });
});

test("formatMemoryContext separates the user from other people", () => {
  const text = formatMemoryContext([
    { memory_type: "preference", content: "Prefers Python." },
    { memory_type: "fact", content: "[about: user's sister] Loves jazz." }
  ]);

  assert.match(text, /About the user:\n- \[preference\] Prefers Python\./);
  assert.match(text, /not facts about the user\):\n- \[fact\] \(user's sister\) Loves jazz\./);
  assert.equal(formatMemoryContext([]), "");
});

test("a clear permanent change supersedes the old preference", () => {
  const old = { id: "m1", memory_type: "preference", content: "Prefers Python for backend development." };
  const plan = planMemoryActions(
    [extracted({ action: "update", replaces_id: "m1" })],
    [old],
    [old],
    NOW
  );

  assert.equal(plan.length, 1);
  assert.equal(plan[0].type, "supersede");
  assert.equal(plan[0].replacesId, "m1");
});

test("an update still supersedes its target when the replacement already exists", () => {
  const old = { id: "python-id", memory_type: "preference", content: "Prefers Python for backend development." };
  const replacement = {
    id: "node-id",
    memory_type: "preference",
    content: "Prefers Node.js for backend development."
  };
  const [step] = planMemoryActions([
    extracted({ action: "update", replaces_id: "python-id", content: replacement.content })
  ], [old], [old, replacement], NOW);

  assert.deepEqual(step, {
    type: "supersede",
    replacesId: "python-id",
    memory: {
      memoryType: "preference",
      content: replacement.content,
      confidence: 0.95,
      importance: 4,
      expiresAt: null
    }
  });
});

test("invalid updates are skipped instead of becoming contradictory additions", () => {
  const old = { id: "m1", memory_type: "preference", content: "Prefers Python." };
  const cases = [
    extracted({ action: "update", replaces_id: "unknown" }),
    extracted({ action: "update", replaces_id: "m1", subject: "user's brother", content: "Prefers Go." }),
    extracted({ action: "update", replaces_id: "m1", duration: "temporary", content: "Using Go this week." }),
    extracted({ action: "update", replaces_id: "m1", confidence: 0.5, content: "Prefers Rust." }),
    extracted({ action: "update", replaces_id: "m1", memory_type: "fact", content: "Works with Go." })
  ];

  for (const item of cases) {
    const [step] = planMemoryActions([item], [old], [old], NOW);

    assert.deepEqual(step, { type: "skip", reason: "invalid_update" });
  }
});

test("another person's fact is stored with its subject", () => {
  const [step] = planMemoryActions(
    [extracted({ subject: "user's sister", memory_type: "fact", content: "Loves jazz." })],
    [],
    [],
    NOW
  );

  assert.equal(step.memory.content, "[about: user's sister] Loves jazz.");
});

test("temporary memories get an expiry date", () => {
  const [step] = planMemoryActions(
    [extracted({ duration: "temporary", expires_in_days: 3, memory_type: "commitment", content: "Busy this week." })],
    [],
    [],
    NOW
  );

  assert.equal(step.memory.expiresAt, "2026-11-28T00:00:00.000Z");

  const [fallback] = planMemoryActions(
    [extracted({ duration: "temporary", expires_in_days: null, content: "Travelling." })],
    [],
    [],
    NOW
  );

  assert.equal(fallback.memory.expiresAt, "2026-12-02T00:00:00.000Z");
});

test("duplicates are skipped even with different punctuation or case", () => {
  const existing = [{ id: "m1", memory_type: "preference", content: "Prefers Node.js for backend development" }];
  const [step] = planMemoryActions(
    [extracted({ content: "prefers node js for backend development!" })],
    existing,
    existing,
    NOW
  );

  assert.deepEqual(step, { type: "skip", reason: "duplicate" });
});

test("invalid items and 'none' actions are ignored", () => {
  const plan = planMemoryActions(
    [extracted({ action: "none" }), extracted({ memory_type: "secret" }), extracted({ importance: 9 })],
    [],
    [],
    NOW
  );

  assert.deepEqual(plan.map((step) => step.type), ["skip", "skip"]);
});

test("one old memory cannot be superseded twice", () => {
  const old = { id: "m1", memory_type: "preference", content: "Prefers Python." };
  const plan = planMemoryActions(
    [
      extracted({ action: "update", replaces_id: "m1", content: "Prefers Node.js." }),
      extracted({ action: "update", replaces_id: "m1", content: "Prefers Go." })
    ],
    [old],
    [old],
    NOW
  );

  assert.deepEqual(plan.map((step) => step.type), ["supersede", "skip"]);
  assert.equal(plan[1].reason, "invalid_update");
});

test("user and other-person preferences keep their explicit subjects", () => {
  const plan = planMemoryActions([
    extracted({ subject: "user", content: "Prefers C++ for DSA." }),
    extracted({ subject: "Rahul", content: "Prefers Java for DSA." })
  ], [], [], NOW);

  assert.equal(plan[0].memory.content, "Prefers C++ for DSA.");
  assert.equal(plan[1].memory.content, "[about: rahul] Prefers Java for DSA.");

  const context = formatMemoryContext(plan.map((step) => ({
    memory_type: step.memory.memoryType,
    content: step.memory.content
  })));

  assert.match(context, /About the user:\n- \[preference\] Prefers C\+\+ for DSA\./);
  assert.match(context, /About other people the user mentioned \(not facts about the user\):\n- \[preference\] \(rahul\) Prefers Java for DSA\./);
});

test("ambiguous third-person content is not attributed to the user", () => {
  const [step] = planMemoryActions([
    extracted({ subject: "user", content: "Rahul prefers Java for DSA." })
  ], [], [], NOW);

  assert.deepEqual(step, { type: "skip", reason: "ambiguous_subject" });
});

test("sentence starters do not make a user preference look third-person", () => {
  const [step] = planMemoryActions([
    extracted({ subject: "user", content: "Currently prefers Node.js for backend development." })
  ], [], [], NOW);

  assert.equal(step.type, "add");
  assert.equal(step.memory.content, "Currently prefers Node.js for backend development.");
});

test("a missing subject is skipped instead of defaulting to the user", () => {
  const item = extracted({ content: "Prefers Java for DSA." });
  delete item.subject;
  const [step] = planMemoryActions([item], [], [], NOW);

  assert.deepEqual(step, { type: "skip", reason: "missing_subject" });
});

test("an explicit about prefix can supply a missing extraction subject", () => {
  const item = extracted({ content: "[about: Rahul] Prefers Java for DSA." });
  delete item.subject;
  const [step] = planMemoryActions([item], [], [], NOW);

  assert.equal(step.type, "add");
  assert.equal(step.memory.content, "[about: rahul] Prefers Java for DSA.");
});

test("memory context labels current and historical preferences separately", () => {
  const context = formatMemoryContext([
    { memory_type: "preference", content: "Prefers Java for backend development." },
    { memory_type: "fact", content: "Previous preference: Prefers Node.js for backend development." },
    { memory_type: "fact", content: "Previous preference: Prefers Python for backend development." },
    { memory_type: "preference", content: "[about: rahul] Prefers Java for DSA." }
  ]);

  assert.match(context, /About the user:\n- \[preference\] Prefers Java for backend development\./);
  assert.match(context, /Historical preferences \(not current\):\n- \[historical preference\] Prefers Node.js for backend development\.\n- \[historical preference\] Prefers Python for backend development\./);
  assert.ok(context.indexOf("Python") > context.indexOf("Historical preferences"));
  assert.match(context, /About other people the user mentioned \(not facts about the user\):\n- \[preference\] \(rahul\) Prefers Java for DSA\./);
});

test("other-person preference history is separated from current other-person memories", () => {
  const context = formatMemoryContext([
    { memory_type: "preference", content: "[about: rahul] Prefers Java for backend development." },
    { memory_type: "fact", content: "[about: rahul] Previous preference: Prefers Python for backend development." }
  ]);

  assert.match(context, /About other people[\s\S]*\(rahul\) Prefers Java/);
  assert.match(context, /Historical preferences \(not current\):[\s\S]*\(rahul\) Prefers Python/);
  assert.doesNotMatch(context, /About other people[\s\S]*Previous preference:/);
});

test("legacy unprefixed memories remain readable as user memories", () => {
  const context = formatMemoryContext([
    { memory_type: "preference", content: "Prefers Python for backend development." }
  ]);

  assert.match(context, /About the user:\n- \[preference\] Prefers Python for backend development\./);
});

test("named-person attribution is case-insensitive", () => {
  for (const content of [
    "Rahul prefers Java for DSA.",
    "rahul prefers Java for DSA.",
    "RAHUL prefers Java for DSA."
  ]) {
    assert.deepEqual(analyzeMemoryAttribution(content), {
      subject: "rahul",
      text: content,
      explicit: false,
      ambiguous: false
    });

    const result = validateMemoryAttribution(content, "user", {
      requireSubject: true
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, "ambiguous_subject");
  }
});

test("safe user wording is not mistaken for a named person", () => {
  const contents = [
    "User prefers C++ for DSA.",
    "Java is the preferred backend language.",
    "Currently prefers Node.js for backend development.",
    "C++ is the preferred DSA language."
  ];

  for (const content of contents) {
    const [step] = planMemoryActions([extracted({ content })], [], [], NOW);

    assert.equal(step.type, "add");
    assert.equal(step.memory.content, content);
  }
});

test("one extraction keeps the user and multiple other people separate", () => {
  const plan = planMemoryActions([
    extracted({ subject: "user", content: "Prefers C++ for DSA." }),
    extracted({ subject: "Rahul", content: "Prefers Java for DSA." }),
    extracted({ subject: "user's sister", content: "Prefers Python for DSA." })
  ], [], [], NOW);

  assert.deepEqual(plan.map((step) => step.memory.content), [
    "Prefers C++ for DSA.",
    "[about: rahul] Prefers Java for DSA.",
    "[about: user's sister] Prefers Python for DSA."
  ]);

  const context = formatMemoryContext(plan.map((step) => ({
    memory_type: step.memory.memoryType,
    content: step.memory.content
  })));

  const userSection = context.split("About other people")[0];
  assert.match(userSection, /Prefers C\+\+ for DSA\./);
  assert.doesNotMatch(userSection, /Rahul|Java|sister|Python/);
  assert.match(context, /\(rahul\) Prefers Java for DSA\./);
  assert.match(context, /\(user's sister\) Prefers Python for DSA\./);
});

test("ambiguous and missing extraction subjects are skipped", () => {
  const missingSubject = extracted({ content: "Prefers Python for DSA." });
  delete missingSubject.subject;

  const plan = planMemoryActions([
    extracted({ subject: "user", content: "He prefers Java for DSA." }),
    missingSubject
  ], [], [], NOW);

  assert.deepEqual(plan, [
    { type: "skip", reason: "ambiguous_subject" },
    { type: "skip", reason: "missing_subject" }
  ]);
});

test("legacy named-person rows are isolated without rewriting safe user rows", () => {
  const context = formatMemoryContext([
    { memory_type: "preference", content: "Prefers Node.js for backend development." },
    { memory_type: "preference", content: "Rahul prefers Java for DSA." },
    { memory_type: "preference", content: "rahul prefers Python for DSA." },
    { memory_type: "preference", content: "RAHUL likes C++." },
    { memory_type: "preference", content: "He prefers Go." },
    { memory_type: "fact", content: "[about: user's sister] Likes jazz." }
  ]);

  const userSection = context.split("Historical preferences")[0]
    .split("About other people")[0];
  assert.match(userSection, /Prefers Node\.js for backend development\./);
  assert.doesNotMatch(userSection, /Rahul|Java|Python|C\+\+|Go|sister/);
  assert.match(context, /\(rahul\) Rahul prefers Java for DSA\./);
  assert.match(context, /\(rahul\) rahul prefers Python for DSA\./);
  assert.match(context, /\(rahul\) RAHUL likes C\+\+\./);
  assert.doesNotMatch(context, /Go/);
  assert.match(context, /\(user's sister\) Likes jazz\./);
});

test("explicit subject prefixes are authoritative and conflicts are rejected", () => {
  const tagged = validateMemoryAttribution(
    "[about: Rahul] Prefers Java for DSA.",
    "friend Rahul",
    { requireSubject: true }
  );

  assert.deepEqual(tagged, {
    valid: true,
    subject: "rahul",
    content: "[about: rahul] Prefers Java for DSA."
  });

  const conflict = validateMemoryAttribution(
    "[about: Rahul] Prefers Java for DSA.",
    "user",
    { requireSubject: true }
  );

  assert.equal(conflict.valid, false);
  assert.equal(conflict.reason, "subject_conflict");
  assert.equal(subjectsMatch("friend RAHUL", "rahul"), true);
  assert.equal(subjectsMatch("user's sister", "sister"), true);
  assert.equal(subjectsMatch("user's sister", "brother"), false);
});

test("empty tagged content and bracket-only subjects are rejected", () => {
  assert.deepEqual(
    validateMemoryAttribution("[about: rahul]", "rahul", { requireSubject: true }),
    { valid: false, reason: "invalid" }
  );

  assert.deepEqual(
    validateMemoryAttribution("Prefers Java for DSA.", "[]", { requireSubject: true }),
    { valid: false, reason: "invalid" }
  );

  assert.deepEqual(
    validateMemoryAttribution("Prefers Java for DSA.", "[ ]", { requireSubject: true }),
    { valid: false, reason: "invalid" }
  );
});

test("manual validation keeps safe user defaults but rejects ambiguous content", () => {
  assert.deepEqual(
    validateMemoryAttribution("Prefers Node.js for backend development.", undefined),
    {
      valid: true,
      subject: "user",
      content: "Prefers Node.js for backend development."
    }
  );

  assert.deepEqual(
    validateMemoryAttribution("Rahul prefers Java for DSA.", undefined),
    { valid: false, reason: "ambiguous_subject" }
  );
});

test("first-person statements always resolve to the user regardless of case", () => {
  const statements = [
    "I prefer Java.",
    "my preferred backend is Node.js.",
    "WE use PostgreSQL in our project.",
    "  Me and my team use PostgreSQL.  "
  ];

  for (const content of statements) {
    const analysis = analyzeMemoryAttribution(content);
    assert.equal(analysis.subject, "user");
    assert.equal(analysis.ambiguous, false);
    assert.equal(validateMemoryAttribution(content, "user").valid, true);
    assert.equal(validateMemoryAttribution(content, "Rahul").reason, "subject_conflict");
  }

  assert.equal(analyzeMemoryAttribution("I prefer Java.").subject, "user");
  assert.equal(analyzeMemoryAttribution("[about: Rahul] I prefer Java.").subject, "rahul");
});

test("named people and relationship descriptors are detected conservatively", () => {
  const cases = [
    ["Rahul prefers Java.", "rahul"],
    ["My friend Rahul uses Java.", "rahul"],
    ["Rahul codes in Java.", "rahul"],
    ["My sister works with Python.", "user's sister"],
    ["Our colleague prefers Node.js.", "user's colleague"],
    ["  RAHUL SWIMS IN JAVA.  ", "rahul"],
    ["Anita Sen builds Java services.", "anita sen"]
  ];

  for (const [content, subject] of cases) {
    const analysis = analyzeMemoryAttribution(content);
    assert.equal(analysis.subject, subject);
    assert.equal(analysis.ambiguous, false);
    assert.equal(validateMemoryAttribution(content, "user").valid, false);
  }
});

test("ordinary names and relationships remain attributable without suffix guessing", () => {
  const cases = [
    ["Rahul spoke Java.", "rahul"],
    ["Chris prefers Java.", "chris"],
    ["Anita Sen spoke Python.", "anita sen"],
    ["Mary Jane Watson uses Java.", "mary jane watson"],
    ["Will uses Java.", "will"],
    ["Dennis prefers Java.", "dennis"],
    ["My manager prefers Java.", "user's manager"],
    ["My manager.", "user's manager"],
    ["My friend Chris uses Java.", "chris"],
    ["My friend Rahul.", "rahul"],
    ["My sister.", "user's sister"],
    ["Our colleague.", "user's colleague"]
  ];

  for (const [content, subject] of cases) {
    assert.equal(analyzeMemoryAttribution(content).subject, subject, content);
    assert.equal(analyzeMemoryAttribution(content).ambiguous, false, content);
  }
});

test("embedded pronouns and mixed first-person attribution are rejected", () => {
  const ambiguous = [
    "Yesterday he preferred Python.",
    "Currently she prefers Java.",
    "Him and his friend use Java.",
    "Them and their team use Python.",
    "I saw him use Java.",
    "He and my manager use Java.",
    "Yesterday he said my manager uses Java.",
    "Rahul said I prefer Java.",
    "Currently my manager prefers Java and I use Python."
  ];

  for (const content of ambiguous) {
    assert.equal(analyzeMemoryAttribution(content).ambiguous, true, content);
    assert.equal(validateMemoryAttribution(content, "user").valid, false, content);
  }

  for (const content of ["I prefer Java.", "Currently I prefer Java."]) {
    assert.equal(validateMemoryAttribution(content, "user").valid, true, content);
    assert.equal(validateMemoryAttribution(content, "Rahul").reason, "subject_conflict", content);
  }

  assert.equal(validateMemoryAttribution("[about: Rahul] He prefers Java.", "Rahul").valid, true);
  assert.equal(
    validateMemoryAttribution("[about: Rahul] Currently I prefer Java.", "Rahul").reason,
    "subject_conflict"
  );
  assert.equal(
    validateMemoryAttribution("[about: user] He prefers Java.", "user").reason,
    "ambiguous_subject"
  );
  assert.equal(
    validateMemoryAttribution("[about: user] Rahul spoke Java.", "user").valid,
    false
  );
  assert.equal(
    validateMemoryAttribution("[about: user] Prefers Java.", "user").valid,
    true
  );
});

test("mixed subjects across clauses are rejected while simple statements remain attributable", () => {
  const ambiguous = [
    "I use C++, but Rahul uses Java.",
    "I use C++, Rahul uses Java.",
    "I prefer Node.js and Rahul prefers Java.",
    "Rahul uses Java and Anita uses Python.",
    "Rahul and Anita use Java.",
    "My friend Rahul uses Python and Anita uses Java.",
    "[about: user] I use C++, but Rahul uses Java."
  ];

  for (const content of ambiguous) {
    assert.equal(analyzeMemoryAttribution(content).ambiguous, true, content);
    assert.equal(validateMemoryAttribution(content, "user").valid, false, content);
  }

  const valid = [
    ["I prefer Node.js.", "user"],
    ["Rahul prefers Java.", "rahul"],
    ["My friend Rahul uses Python.", "rahul"],
    ["My brother works with Java.", "user's brother"],
    ["My backend preference is Node.js.", "user"],
    ["My DSA preference is Node.js.", "user"],
    ["Me and my team use PostgreSQL.", "user"]
  ];

  for (const [content, subject] of valid) {
    const analysis = analyzeMemoryAttribution(content);
    assert.equal(analysis.subject, subject, content);
    assert.equal(analysis.ambiguous, false, content);
  }
});

test("pronoun-only statements cannot inherit a name from earlier messages", () => {
  const messages = ["Rahul prefers Java.", "He prefers Python."];
  const plan = planMemoryActions(messages.map((content, index) => extracted({
    subject: index === 0 ? "Rahul" : "Rahul",
    content
  })), [], [], NOW);

  assert.equal(plan[0].memory.content, "[about: rahul] Rahul prefers Java.");
  assert.deepEqual(plan[1], { type: "skip", reason: "ambiguous_subject" });

  for (const content of ["He prefers Java.", "SHE uses Python.", "They like Node.js.", "It works with Go."]) {
    for (const subject of ["user", "Rahul", undefined]) {
      assert.equal(validateMemoryAttribution(content, subject).reason, "ambiguous_subject");
    }
  }

  assert.equal(validateMemoryAttribution("[about: Rahul] He prefers Java.", "Rahul").valid, true);
});

test("relationship descriptors normalize without merging different people", () => {
  for (const subject of ["Rahul", "friend Rahul", "My friend Rahul", "RAHUL", "  friend   RAHUL  "]) {
    assert.equal(normalizeSubject(subject), "rahul");
  }

  assert.equal(normalizeSubject("sister"), "user's sister");
  assert.equal(normalizeSubject("My sister"), "user's sister");
  assert.equal(normalizeSubject("friend Rahul"), "rahul");
  assert.equal(normalizeSubject("friend Aman"), "aman");
  assert.equal(subjectsMatch("friend Rahul", "RAHUL"), true);
  assert.equal(subjectsMatch("friend Rahul", "friend Aman"), false);
});

test("canonical subject identity includes composed accents and full-width Latin", () => {
  const pairs = [
    ["Café", "Cafe\u0301"],
    ["Ｒａｈｕｌ", "Rahul"]
  ];

  for (const [stored, incoming] of pairs) {
    const expected = normalizeSubject(stored);
    assert.equal(normalizeSubject(incoming), expected);
    assert.equal(subjectsMatch(incoming, stored), true);
    assert.equal(buildMemoryContent(stored, "Prefers tea."), buildMemoryContent(incoming, "Prefers tea."));
    assert.deepEqual(parseMemorySubject(buildMemoryContent(incoming, "Prefers tea.")), {
      subject: expected,
      text: "Prefers tea."
    });
  }
});

test("the planner deduplicates canonically equivalent subject identities", () => {
  for (const [subject, storedContent] of [
    ["Cafe\u0301", "[about: café] Prefers tea."],
    ["Ｒａｈｕｌ", "[about: rahul] Prefers tea."]
  ]) {
    const existing = [{
      id: `memory-${subject}`,
      memory_type: "preference",
      content: storedContent,
      expires_at: null
    }];
    const [step] = planMemoryActions([
      extracted({ subject, content: "Prefers tea." })
    ], existing, existing, NOW);

    assert.deepEqual(step, { type: "skip", reason: "duplicate" });
  }
});

test("preference categories preserve their existing ASCII compatibility behavior", () => {
  assert.equal(getPreferenceCategory("Prefers Node.js for BACKEND development."), "backend");
  assert.equal(getPreferenceCategory("Practices data structures and algorithms."), "dsa");
  assert.equal(getPreferenceCategory("Builds Frontend interfaces."), "frontend");
  assert.equal(getPreferenceCategory("[about: Ｃａｆｅ] ＢＡＣＫＥＮＤ"), null);
});

test("temporary and permanent duplicate identity includes expiration", () => {
  const content = "Travelling this week.";
  const expiry = "2026-12-01T00:00:00.000Z";
  const otherExpiry = "2026-12-02T00:00:00.000Z";
  const permanent = [{ id: "permanent", memory_type: "commitment", content, expires_at: null }];
  const temporary = [{ id: "temporary", memory_type: "commitment", content, expires_at: expiry }];

  const check = (existing, duration, expiresInDays) => planMemoryActions([
    extracted({ memory_type: "commitment", content, duration, expires_in_days: expiresInDays })
  ], existing, existing, NOW)[0];

  assert.equal(check(permanent, "permanent", null).reason, "duplicate");
  assert.equal(check(temporary, "temporary", 6).reason, "duplicate");
  assert.equal(check(temporary, "temporary", 7).type, "add");
  assert.equal(check(temporary, "permanent", null).type, "add");
  assert.equal(check(permanent, "temporary", 6).type, "add");
  assert.equal(check([{ ...temporary[0], expires_at: otherExpiry }], "temporary", 6).type, "add");
});

test("leading whitespace and mixed-case explicit subjects parse without changing meaning", () => {
  const result = validateMemoryAttribution("\n\t  [AbOuT:   Friend RAHUL ]   Prefers Java.  \t", "Rahul", {
    requireSubject: true
  });

  assert.deepEqual(result, {
    valid: true,
    subject: "rahul",
    content: "[about: rahul] Prefers Java."
  });

  for (const content of ["[about Rahul] Prefers Java.", "[about:] Prefers Java.", "[about: [rahul]] Prefers Java."]) {
    assert.equal(validateMemoryAttribution(content, "Rahul").reason, "ambiguous_subject");
  }
});

test("memory normalization preserves existing ASCII punctuation and whitespace behavior", () => {
  assert.equal(
    normalizeMemoryKey("  Prefers\tNode.js, for BACKEND development!!!  "),
    "prefers node js for backend development"
  );
  assert.equal(normalizeMemoryKey("User's C++ project."), "user s c project");
  assert.equal(normalizeMemoryText("[about: Rahul] Prefers Java for DSA."), "prefers java for dsa");
  assert.notEqual(
    normalizeMemoryKey("[about: rahul] Prefers tea."),
    normalizeMemoryKey("[about: aman] Prefers tea.")
  );
});

test("memory normalization preserves distinct Hindi, Chinese, Arabic, and Japanese text", () => {
  const distinctPairs = [
    ["मुझे चाय पसंद है", "मुझे कॉफी पसंद है"],
    ["我喜欢喝茶", "我喜欢喝咖啡"],
    ["أحب القهوة", "أحب الشاي"],
    ["私はコーヒーが好きです", "私はお茶が好きです"]
  ];

  for (const [left, right] of distinctPairs) {
    const leftKey = normalizeMemoryKey(left);
    const rightKey = normalizeMemoryKey(right);

    assert.ok(leftKey);
    assert.ok(rightKey);
    assert.notEqual(leftKey, rightKey);
  }

  assert.equal(normalizeMemoryKey("मुझे चाय पसंद है"), "मुझे चाय पसंद है");
  assert.equal(normalizeMemoryKey("我喜欢喝茶"), "我喜欢喝茶");
  assert.equal(normalizeMemoryKey("أحب القهوة"), "أحب القهوة");
  assert.equal(normalizeMemoryKey("私はコーヒーが好きです"), "私はコーヒーが好きです");
});

test("memory normalization preserves combining marks and canonical equivalents", () => {
  assert.equal(normalizeMemoryKey("Cafe\u0301"), "café");
  assert.equal(normalizeMemoryKey("Cafe\u0301"), normalizeMemoryKey("Café"));
  assert.equal(normalizeMemoryKey("कि"), normalizeMemoryKey("\u0915\u093f"));
  assert.ok(normalizeMemoryKey("कि").includes("\u093f"));
});

test("empty and symbol-only content never produces a duplicate key", () => {
  for (const content of ["", "   ", "!!!", "😀🔥", "\u0301"]) {
    assert.equal(normalizeMemoryKey(content), "");
  }
});

test("equivalent Unicode text is still deduplicated by the planner", () => {
  const existing = [{
    id: "hindi-tea",
    memory_type: "preference",
    content: "मुझे चाय पसंद है",
    expires_at: null
  }];
  const [step] = planMemoryActions([
    extracted({ content: "मुझे   चाय, पसंद है!" })
  ], existing, existing, NOW);

  assert.deepEqual(step, { type: "skip", reason: "duplicate" });
});

test("non-equivalent Unicode memories do not collide in the planner", () => {
  const pairs = [
    ["मुझे चाय पसंद है", "मुझे कॉफी पसंद है"],
    ["我喜欢喝茶", "我喜欢喝咖啡"],
    ["أحب القهوة", "أحب الشاي"],
    ["私はコーヒーが好きです", "私はお茶が好きです"]
  ];

  for (const [first, second] of pairs) {
    const plan = planMemoryActions([
      extracted({ content: first }),
      extracted({ content: second })
    ], [], [], NOW);

    assert.deepEqual(plan.map((step) => step.type), ["add", "add"]);
  }
});

test("symbol-only planner entries do not match each other through an empty key", () => {
  const existing = [{
    id: "symbols",
    memory_type: "fact",
    content: "!!!",
    expires_at: null
  }];
  const plan = planMemoryActions([
    extracted({ memory_type: "fact", content: "???" }),
    extracted({ memory_type: "fact", content: "😀🔥" })
  ], existing, existing, NOW);

  assert.deepEqual(plan.map((step) => step.type), ["add", "add"]);
});
