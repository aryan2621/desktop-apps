import { useState } from "react";
import { KeyRound, Check, Save } from "lucide-react";
import { api } from "./api";
import { providers, type Provider } from "./types";
export default function Providers({
  configured,
  onSave,
  onError,
}: {
  configured: Provider[];
  onSave: (p: Provider) => void;
  onError: (e: unknown) => void;
}) {
  const [selected, setSelected] = useState("claude");
  return (
    <div className="provider-layout">
      <div className="provider-list">
        {providers.map((p) => (
          <button
            className={`provider-option ${selected === p.id ? "active" : ""}`}
            key={p.id}
            onClick={() => setSelected(p.id)}
          >
            <div className={`provider-icon ${p.id}`}>{p.name[0]}</div>
            <div>
              <strong>{p.name}</strong>
              <span>{p.detail}</span>
            </div>
            {configured.some((c) => c.id === p.id) && <Check size={15} />}
          </button>
        ))}
      </div>
      <ProviderForm
        key={selected}
        id={selected}
        initial={configured.find((p) => p.id === selected)}
        onSave={onSave}
        onError={onError}
      />
    </div>
  );
}
const placeholders: Record<string, string> = {
  claude: "e.g. claude-sonnet-5-5",
  openai: "A model ID from your OpenAI account",
  gemini: "A model ID from Google AI Studio",
};
function ProviderForm({
  id,
  initial,
  onSave,
  onError,
}: {
  id: string;
  initial?: Provider;
  onSave: (p: Provider) => void;
  onError: (e: unknown) => void;
}) {
  const [model, setModel] = useState(initial?.model ?? ""),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const save = async (clear = false) => {
    setBusy(true);
    try {
      const provider = { id, model: model.trim(), baseUrl: "" };
      await api("save_provider", { provider, key: clear ? "" : key || null });
      setKey("");
      setSaved(true);
      onSave(provider);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel provider-form">
      <div className="provider-form-title">
        <h3>{providers.find((p) => p.id === id)?.name}</h3>
        <p>
          Requests are billed to your own account. Your messages, the tools you
          enable and their results are sent to this provider.
        </p>
      </div>
      <label>
        Model ID
        <input
          placeholder={placeholders[id]}
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label>
        API key
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            initial ? "Leave blank to keep the saved key" : "Paste your API key"
          }
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setSaved(false);
          }}
        />
      </label>
      <div className="notice">
        <KeyRound size={15} />
        <span>Stored in macOS Keychain, never in Relay’s files.</span>
      </div>
      <div className="provider-actions">
        {initial && (
          <button
            className="text-button danger"
            disabled={busy}
            onClick={() => save(true)}
          >
            Remove saved key
          </button>
        )}
        <button
          className="button primary"
          disabled={busy || !model.trim() || (!initial && !key.trim())}
          onClick={() => save()}
        >
          {saved ? <Check size={15} /> : <Save size={15} />}{" "}
          {busy ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
      </div>
    </section>
  );
}
