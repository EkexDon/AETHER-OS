import { useState } from "react";
import { Check, Cloud, HardDrive } from "lucide-react";
import { useAetherStore } from "../../lib/store";
import { getHealth, setOpenRouterKey, listCloudModels } from "../../lib/ipc";
import { Badge, Button, Input, Kbd } from "../../ui";
import { SettingsGroup, SettingsPage, SettingsRow } from "../layout";

/** Ollama + OpenRouter configuration (moved from the former SettingsPanel). */
export function AiProviderSettings() {
  const { health, setHealth, modelByProvider } = useAetherStore();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyStatus, setKeyStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [keyMessage, setKeyMessage] = useState<string | null>(null);

  const handleSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setKeyStatus("saving");
    setKeyMessage(null);
    try {
      await setOpenRouterKey(apiKeyInput.trim());
      setApiKeyInput("");
      const h = await getHealth();
      setHealth(h);
      setKeyStatus("saved");
      setKeyMessage("Key saved.");
      setTimeout(() => setKeyStatus("idle"), 2000);
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : String(e));
      setKeyStatus("error");
    }
  };

  const handleTestKey = async () => {
    setKeyStatus("saving");
    setKeyMessage(null);
    try {
      const models = await listCloudModels();
      setKeyStatus("saved");
      setKeyMessage(`Connected — ${models.length} models available.`);
      setTimeout(() => setKeyStatus("idle"), 3000);
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : String(e));
      setKeyStatus("error");
    }
  };

  const ollama = !!health?.ollama_online;
  const openrouter = !!health?.openrouter_configured;

  return (
    <SettingsPage
      title="AI Providers"
      description="AETHER chats through local Ollama by default, or cloud models via OpenRouter (Claude, GPT, Gemini and more)."
    >
      <SettingsGroup title="Local — Ollama">
        <SettingsRow
          label="Connection"
          hint="Runs entirely on this machine. Nothing leaves your computer."
          control={
            <Badge variant={ollama ? "success" : "neutral"} dot icon={<HardDrive size={11} />}>
              {ollama ? "Connected" : "Offline"}
            </Badge>
          }
        />
        <SettingsRow
          label="Default model"
          hint={
            <>
              Install with <code className="settings-code">ollama pull {modelByProvider.ollama}</code> — or pick any
              installed model from the agent panel, or type <Kbd>/model</Kbd> in the chat.
            </>
          }
          control={<span className="settings-value mono">{modelByProvider.ollama}</span>}
        />
      </SettingsGroup>

      <SettingsGroup title="Cloud — OpenRouter">
        <SettingsRow
          label="Connection"
          hint="Your key is stored in the app's private data directory — never in the browser or your vault."
          control={
            <Badge variant={openrouter ? "success" : "neutral"} dot icon={<Cloud size={11} />}>
              {openrouter ? "Key configured" : "No key"}
            </Badge>
          }
        />
        <SettingsRow label="API key" stacked htmlFor="settings-openrouter-key">
          <div className="ui-field-row">
            <Input
              id="settings-openrouter-key"
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder={openrouter ? "•••••••• (saved)" : "sk-or-v1-…"}
              autoComplete="off"
              spellCheck={false}
              invalid={keyStatus === "error"}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSaveKey();
              }}
            />
            <Button
              variant="secondary"
              onClick={() => void handleTestKey()}
              loading={keyStatus === "saving" && !apiKeyInput.trim()}
              disabled={keyStatus === "saving"}
              iconLeft={<Cloud size={14} />}
            >
              Test
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSaveKey()}
              loading={keyStatus === "saving" && !!apiKeyInput.trim()}
              disabled={keyStatus === "saving" || !apiKeyInput.trim()}
              iconLeft={keyStatus === "saved" ? <Check size={14} /> : undefined}
            >
              {keyStatus === "saved" ? "Saved" : "Save key"}
            </Button>
          </div>
          {keyMessage && (
            <p className={keyStatus === "error" ? "ui-field-error settings-inline-error" : "ui-field-hint settings-inline-hint"}>
              {keyMessage}
            </p>
          )}
        </SettingsRow>
        <SettingsRow
          label="Default cloud model"
          hint="Change it any time from the agent panel's model picker."
          control={<span className="settings-value mono">{modelByProvider.openrouter}</span>}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
