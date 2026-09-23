import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { usePluginsStore } from "../../lib/pluginsStore";
import { describePermission, type PermissionRisk } from "../../lib/plugins/permissions";
import { Badge, Button, Modal, Switch, useToast } from "../../ui";

const RISK_BADGE: Record<PermissionRisk, { variant: "neutral" | "warning" | "danger"; label: string }> = {
  low: { variant: "neutral", label: "Low risk" },
  medium: { variant: "warning", label: "Sensitive" },
  high: { variant: "danger", label: "High risk" },
};

/**
 * Review (and in `enable` mode: grant, then enable) the permissions a
 * plugin requests. Driven by `usePluginsStore().review`.
 */
export function PermissionsModal() {
  const review = usePluginsStore((s) => s.review);
  const plugin = usePluginsStore((s) => s.plugins.find((p) => p.manifest.id === s.review?.id) ?? null);
  const closeReview = usePluginsStore((s) => s.closeReview);
  const setPermissions = usePluginsStore((s) => s.setPermissions);
  const grantAndEnable = usePluginsStore((s) => s.grantAndEnable);
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const requested = plugin?.manifest.permissions ?? [];
  const enableMode = review?.mode === "enable";

  useEffect(() => {
    if (!plugin) return;
    const granted = plugin.granted_permissions;
    // Enabling for the first time pre-selects everything the plugin asks for;
    // the user switches off what they do not want to hand out.
    setSelected(new Set(enableMode && granted.length === 0 ? plugin.manifest.permissions : granted));
  }, [plugin, enableMode]);

  if (!review || !plugin) return null;
  const name = plugin.manifest.name;

  const toggle = (permission: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(permission);
      else next.delete(permission);
      return next;
    });

  const submit = async () => {
    setSaving(true);
    const permissions = requested.filter((p) => selected.has(p));
    try {
      if (enableMode) {
        await grantAndEnable(plugin.manifest.id, permissions);
        toast.success(`${name} is enabled`, {
          description: `${permissions.length} of ${requested.length} permission${requested.length === 1 ? "" : "s"} granted.`,
        });
      } else {
        await setPermissions(plugin.manifest.id, permissions);
        toast.success(`Permissions of ${name} updated`);
      }
      closeReview();
    } catch (error) {
      toast.error(enableMode ? `${name} could not be enabled` : "Permissions were not saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={closeReview}
      icon={ShieldCheck}
      size="md"
      title={enableMode ? `Enable ${name}?` : `Permissions for ${name}`}
      description={
        requested.length > 0
          ? "Plugins only get the permissions you switch on. You can change this at any time."
          : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={closeReview}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {enableMode ? "Enable plugin" : "Save permissions"}
          </Button>
        </>
      }
    >
      {requested.length === 0 ? (
        <p className="plugin-permissions-empty">
          {name} requests no permissions. It can show notifications, keep its own storage and read its settings — nothing
          else.
        </p>
      ) : (
        <ul className="plugin-permission-list">
          {requested.map((permission) => {
            const described = describePermission(permission);
            const risk = RISK_BADGE[described.risk];
            return (
              <li key={permission} className="plugin-permission-row">
                <div className="plugin-permission-text">
                  <div className="plugin-permission-title">
                    <span>{described.label}</span>
                    <Badge size="sm" variant={risk.variant}>
                      {risk.label}
                    </Badge>
                  </div>
                  <p className="plugin-permission-description">{described.description}</p>
                  <code className="plugin-permission-code">{permission}</code>
                </div>
                <Switch
                  checked={selected.has(permission)}
                  onChange={(on) => toggle(permission, on)}
                  aria-label={`${described.label} (${permission})`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
