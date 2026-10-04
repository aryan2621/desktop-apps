import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowDownToLine, Check, Cpu, Trash2 } from "lucide-react";
import { api } from "./api";
import Providers from "./Providers";
import { type Catalog, type Provider } from "./types";
const gb = (mb: number) => `${(mb / 1000).toFixed(1)} GB`;
export default function Models({
  catalog,
  refresh,
  configured,
  onProvider,
  notify,
  onError,
}: {
  catalog: Catalog | null;
  refresh: () => Promise<void>;
  configured: Provider[];
  onProvider: (p: Provider) => void;
  notify: (text: string) => void;
  onError: (e: unknown) => void;
}) {
  const [download, setDownload] = useState<{
    id: string;
    done: number;
    total: number;
  } | null>(null);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void listen<{ id: string; done: number; total: number }>(
      "model-progress",
      (e) => setDownload(e.payload),
    )
      .then((fn) => {
        dispose = fn;
      })
      .catch(onError);
    return () => dispose?.();
  }, [onError]);
  const inUse = configured.find((p) => p.id === "local")?.model;
  const use = async (id: string) => {
    try {
      const p = { id: "local", model: id, baseUrl: "" };
      await api("save_provider", { provider: p, key: null });
      onProvider(p);
    } catch (e) {
      onError(e);
    }
  };
  const start = async (id: string) => {
    setDownload({ id, done: 0, total: 0 });
    try {
      await api("download_model", { id });
      await refresh();
      // The first model someone downloads is the one they want to use.
      if (!inUse) await use(id);
      notify("Model downloaded and verified");
    } catch (e) {
      onError(e);
    } finally {
      setDownload(null);
    }
  };
  const remove = async (id: string) => {
    try {
      await api("delete_model", { id });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };
  if (!catalog) return null;
  const recommended = catalog.models.find((m) => m.id === catalog.recommended);
  return (
    <div className="models-page">
      <section>
        <div className="section-heading">
          <div>
            <h2>On this Mac</h2>
            <p>
              Free and private. Models run on this Mac, so nothing you send them
              leaves it.
            </p>
          </div>
        </div>
        <div className="device-note">
          <Cpu size={17} />
          <span>
            This Mac has <strong>{catalog.ramGb} GB</strong> of memory.{" "}
            {recommended && (
              <>
                <strong>{recommended.name}</strong> is the best fit for it.
              </>
            )}
          </span>
        </div>
        <div className="model-list">
          {catalog.models.map((m) => {
            const tooBig = m.minRamGb > catalog.ramGb,
              active = download?.id === m.id;
            return (
              <article className="model-row" key={m.id}>
                <div className="model-text">
                  <div className="model-title">
                    <strong>{m.name}</strong>
                    {m.id === catalog.recommended && (
                      <span className="badge accent">Recommended</span>
                    )}
                    {inUse === m.id && m.installed && (
                      <span className="badge success">In use</span>
                    )}
                  </div>
                  <p>{m.note}</p>
                  <span className="model-meta">
                    {gb(m.sizeMb)} · needs {m.minRamGb} GB of memory
                    {tooBig && " · more than this Mac has"}
                  </span>
                </div>
                <div className="model-actions">
                  {active ? (
                    <div className="download-progress">
                      <progress
                        max={download.total || 1}
                        value={download.done}
                      />
                      <span>
                        {download.total
                          ? `${Math.round((download.done / download.total) * 100)}%`
                          : "Starting…"}
                      </span>
                      <button
                        className="text-button"
                        onClick={() =>
                          void api("cancel_download").catch(onError)
                        }
                      >
                        Cancel
                      </button>
                    </div>
                  ) : m.installed ? (
                    <>
                      {inUse !== m.id && (
                        <button className="button" onClick={() => use(m.id)}>
                          <Check size={14} /> Use
                        </button>
                      )}
                      <button
                        className="icon-button"
                        aria-label={`Delete ${m.name}`}
                        onClick={() => remove(m.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  ) : (
                    <button
                      className={`button ${m.id === catalog.recommended ? "primary" : ""}`}
                      disabled={!!download}
                      onClick={() => start(m.id)}
                    >
                      <ArrowDownToLine size={14} /> Download
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        <p className="hint">
          4-bit versions from Hugging Face, checked against their published
          checksum after download.{" "}
          <button
            className="text-button"
            onClick={() =>
              void api("stop_model")
                .then(() => notify("Model unloaded; its memory is free again"))
                .catch(onError)
            }
          >
            Unload the running model
          </button>
        </p>
      </section>
      <section>
        <div className="section-heading">
          <div>
            <h2>With an API key</h2>
            <p>The strongest models, from your own account.</p>
          </div>
        </div>
        <Providers
          configured={configured}
          onSave={onProvider}
          onError={onError}
        />
      </section>
    </div>
  );
}
