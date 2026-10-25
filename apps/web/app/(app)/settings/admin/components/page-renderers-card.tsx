"use client";

import { useState } from "react";
import { SwitchRow } from "@/app/(app)/settings/components/setting-row";
import { SettingsCard } from "@/app/(app)/settings/components/settings-card";
import SettingsSwitch from "@/app/(app)/settings/components/settings-switch";
import { useTRPC } from "@/app/providers/trpc-provider";
import { ActionButton, ActionButtonGroup } from "@/components/shared/action-button";
import { showSafeErrorToast } from "@/lib/ui/safe-error-toast";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { Description, Input, Label, Separator, TextField, toast } from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import type { PageRenderersConfig } from "@norish/config/zod/server-config";

import { UnsavedChangesChip } from "./unsaved-changes-chip";

const DEFAULT_TIMEOUT_MS = 45_000;
// Both answer on the private compose network, without TLS.
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- placeholder for the shipped service
const OBSCURA_PLACEHOLDER = "ws://obscura:9222";
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- placeholder for the commented-out service
const SOLVER_PLACEHOLDER = "http://flaresolverr:8191/v1";

/** The form's copy of the setting: every field a string or switch, the token as typed. */
function formFrom(config: PageRenderersConfig | null | undefined) {
  return {
    obscuraEnabled: config?.obscura.enabled ?? false,
    obscuraEndpoint: config?.obscura.endpoint ?? "",
    cdpToken: "",
    solverEnabled: config?.solver.enabled ?? false,
    solverEndpoint: config?.solver.endpoint ?? "",
    allowPrivateAddresses: config?.allowPrivateAddresses ?? false,
    navigationTimeoutMs: String(config?.navigationTimeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
}

/** Obscura and a FlareSolverr-compatible solver, tried in that order (ADR-0019). */
export default function PageRenderersCard() {
  const t = useTranslations("settings.admin.pageRenderers");
  const tActions = useTranslations("common.actions");
  const tErrors = useTranslations("common.errors");
  const tSecret = useTranslations("common.secret");
  const trpc = useTRPC();
  const stored = useQuery(trpc.admin.getPageRenderers.queryOptions());
  const [form, setForm] = useState(() => formFrom(stored.data));
  const [prevStored, setPrevStored] = useState(stored.data);

  if (stored.data !== prevStored) {
    setPrevStored(stored.data);
    setForm(formFrom(stored.data));
  }

  const save = useMutation(
    trpc.admin.updatePageRenderers.mutationOptions({
      onSuccess: () => {
        toast(t("saved"), { variant: "success" });
        void stored.refetch();
      },
      onError: (error) =>
        showSafeErrorToast({
          title: t("error"),
          description: tErrors("technicalDetails"),
          color: "danger",
          error,
          context: "admin-page-renderers:save",
        }),
    })
  );

  const set =
    <K extends keyof typeof form>(key: K) =>
    (value: (typeof form)[K]) =>
      setForm((current) => ({ ...current, [key]: value }));
  const initial = formFrom(stored.data);
  const isDirty = (Object.keys(form) as (keyof typeof form)[]).some(
    (key) => form[key] !== initial[key]
  );
  const hasStoredToken = !!stored.data?.obscura.cdpToken;

  const handleSave = () =>
    save.mutate({
      obscura: {
        enabled: form.obscuraEnabled,
        endpoint: form.obscuraEndpoint.trim(),
        // Empty keeps the stored token on the server.
        cdpToken: form.cdpToken || undefined,
      },
      solver: {
        enabled: form.solverEnabled,
        endpoint: form.solverEndpoint.trim() || undefined,
      },
      allowPrivateAddresses: form.allowPrivateAddresses,
      navigationTimeoutMs: parseInt(form.navigationTimeoutMs) || DEFAULT_TIMEOUT_MS,
    });

  return (
    <SettingsCard
      badges={isDirty ? <UnsavedChangesChip /> : null}
      contentClassName="gap-6"
      data-testid="page-renderers-card"
      description={t("description")}
      icon={GlobeAltIcon}
      title={t("title")}
    >
      <SwitchRow description={t("obscuraDescription")} title={t("obscura")}>
        <SettingsSwitch
          aria-label={t("obscura")}
          isDisabled={stored.isLoading}
          isSelected={form.obscuraEnabled}
          onValueChange={set("obscuraEnabled")}
        />
      </SwitchRow>
      {form.obscuraEnabled && (
        <>
          <TextField value={form.obscuraEndpoint} onChange={set("obscuraEndpoint")}>
            <Label>{t("obscuraEndpoint")}</Label>
            <Input placeholder={OBSCURA_PLACEHOLDER} variant="secondary" />
          </TextField>
          <TextField type="password" value={form.cdpToken} onChange={set("cdpToken")}>
            <Label>{t("cdpToken")}</Label>
            <Input placeholder={hasStoredToken ? "••••••••••••" : undefined} variant="secondary" />
            <Description>
              {hasStoredToken
                ? `${t("cdpTokenDescription")} ${tSecret("keepsCurrent")}`
                : t("cdpTokenDescription")}
            </Description>
          </TextField>
        </>
      )}

      <Separator />

      <SwitchRow description={t("solverDescription")} title={t("solver")}>
        <SettingsSwitch
          aria-label={t("solver")}
          isDisabled={stored.isLoading}
          isSelected={form.solverEnabled}
          onValueChange={set("solverEnabled")}
        />
      </SwitchRow>
      {form.solverEnabled && (
        <TextField value={form.solverEndpoint} onChange={set("solverEndpoint")}>
          <Label>{t("solverEndpoint")}</Label>
          <Input placeholder={SOLVER_PLACEHOLDER} variant="secondary" />
        </TextField>
      )}

      <Separator />

      <SwitchRow
        description={t("allowPrivateAddressesDescription")}
        title={t("allowPrivateAddresses")}
      >
        <SettingsSwitch
          aria-label={t("allowPrivateAddresses")}
          isDisabled={stored.isLoading}
          isSelected={form.allowPrivateAddresses}
          onValueChange={set("allowPrivateAddresses")}
        />
      </SwitchRow>

      <TextField
        type="number"
        value={form.navigationTimeoutMs}
        onChange={set("navigationTimeoutMs")}
      >
        <Label>{t("navigationTimeout")}</Label>
        <Input min={1} variant="secondary" />
        <Description>{t("navigationTimeoutDescription")}</Description>
      </TextField>

      <ActionButtonGroup>
        <ActionButton
          action="save"
          isDisabled={!isDirty}
          isPending={save.isPending}
          onPress={handleSave}
        >
          {tActions("save")}
        </ActionButton>
      </ActionButtonGroup>
    </SettingsCard>
  );
}
