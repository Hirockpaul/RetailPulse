import { useState, type FormEvent } from 'react';
import { askAssistant, type AssistantAnswer } from '../api/assistant';
import { ErrorMessage } from '../components/Status';

const EXAMPLES = [
  'What needs attention across the stores?',
  'Which locations have the most open work?',
  'Summarise the critical replenishment suggestions.',
  'What high-severity unusual activity should be checked?',
];

const TOOL_LABELS: Record<string, string> = {
  get_control_tower: 'Control Tower',
  get_location_health: 'location health',
  get_open_anomalies: 'open unusual activity',
  get_pending_recommendations: 'pending recommendations',
};

export function AssistantPage() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = question.trim();
    if (value.length < 3 || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await askAssistant(value));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not ask the assistant.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section aria-labelledby="assistant-heading" className="mx-auto max-w-3xl space-y-5">
      <div>
        <h2 id="assistant-heading" className="text-xl font-semibold">
          Read-only assistant
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Ask about the verified Control Tower, location health, unusual activity, or pending
          recommendations that your account may access.
        </p>
      </div>

      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        The assistant can only read synthetic demo data. It cannot change stock, review findings,
        approve recommendations, or create orders. Your question is sent to the configured AI
        provider; do not include names, email addresses, or private notes.
      </div>

      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        <label htmlFor="assistant-question" className="block text-sm font-medium">
          Question
        </label>
        <textarea
          id="assistant-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={500}
          rows={4}
          placeholder="What should I look at first today?"
          className="w-full rounded border bg-white px-3 py-2 text-sm focus:outline-2 focus:outline-sky-500"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500">{question.length}/500 characters</span>
          <button
            type="submit"
            disabled={question.trim().length < 3 || loading}
            className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Checking verified data…' : 'Ask assistant'}
          </button>
        </div>
      </form>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Example questions
        </p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setQuestion(example)}
              className="rounded-full border bg-white px-3 py-1.5 text-left text-xs hover:bg-slate-100"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      <div aria-live="polite">
        {error && <ErrorMessage message={error} />}
        {answer && <Answer answer={answer} />}
      </div>
    </section>
  );
}

function Answer({ answer }: { answer: AssistantAnswer }) {
  const provider = answer.provider === 'nvidia' ? 'NVIDIA' : 'Groq';
  return (
    <div className="space-y-3 rounded border border-sky-100 bg-sky-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
        {answer.source === 'ai' ? `AI answer (${provider})` : 'Local guidance'}
      </p>
      {answer.claims.map((claim, index) => (
        <p key={`${claim.type}-${index}`} className="text-sm">
          <span className="mr-2 rounded bg-white px-1.5 py-0.5 text-xs font-medium text-slate-600">
            {claim.type}
          </span>
          {claim.text}
        </p>
      ))}
      {answer.toolsUsed.length > 0 && (
        <p className="text-xs text-slate-500">
          Checked: {answer.toolsUsed.map((tool) => TOOL_LABELS[tool] ?? tool).join(', ')}. Values
          were loaded after applying your account’s permissions.
        </p>
      )}
      <p className="text-xs text-slate-500">
        This explanation does not make decisions or change RetailPulse data.
      </p>
    </div>
  );
}
