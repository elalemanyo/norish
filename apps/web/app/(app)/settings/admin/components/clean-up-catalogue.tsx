"use client";

import { useState } from "react";
import { SettingRow } from "@/app/(app)/settings/components/setting-row";
import { useTRPC } from "@/app/providers/trpc-provider";
import { AIButton } from "@/components/shared/ai-button";
import { cssAIIconColor } from "@/config/css-tokens";
import { showSafeErrorToast } from "@/lib/ui/safe-error-toast";
import { SparklesIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
  Button,
  Description,
  Label,
  Modal,
  Radio,
  RadioGroup,
  Spinner,
  toast,
} from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { twMerge } from "tailwind-merge";

import { useAdminSettingsContext } from "../context";

const SCOPES = ["recipe-foods", "whole-catalogue"] as const;

type Scope = (typeof SCOPES)[number];

const COUNT_OF = { "recipe-foods": "recipeFoods", "whole-catalogue": "wholeCatalogue" } as const;

/** Clean up catalogue: AI over the foods already listed, in one job, after a scope and a confirm. */
export default function CleanUpCatalogue() {
  const t = useTranslations("settings.admin.aiProcessing.ingredientCatalogue.cleanUpCatalogue");
  const tActions = useTranslations("common.actions");
  const tErrors = useTranslations("common.errors");
  const trpc = useTRPC();
  const { aiConfig } = useAdminSettingsContext();
  const [isOpen, setIsOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("recipe-foods");
  const counts = useQuery(
    trpc.admin.ingredientCatalogue.cleanUpCounts.queryOptions(undefined, {
      refetchOnMount: "always",
      // A run on is watched until it ends, so the button comes back by itself.
      refetchInterval: (query) => (query.state.data?.running ? 5_000 : false),
    })
  );
  const cleanUp = useMutation(
    trpc.admin.ingredientCatalogue.cleanUp.mutationOptions({
      onSuccess: ({ queued }) => {
        setIsOpen(false);
        toast(t("started", { count: queued }), { variant: "success" });
      },
      onError: (error) =>
        showSafeErrorToast({
          title: t("error"),
          description: tErrors("technicalDetails"),
          color: "danger",
          error,
          context: "admin-ai:clean-up-catalogue",
        }),
      onSettled: () => void counts.refetch(),
    })
  );
  const count = counts.data?.[COUNT_OF[scope]] ?? 0;

  return (
    <SettingRow
      description={counts.data?.running ? t("running") : t("description")}
      title={t("title")}
    >
      <AIButton
        data-testid="clean-up-catalogue"
        isDisabled={!aiConfig?.enabled || !counts.data || counts.data.running}
        variant="tertiary"
        onPress={() => setIsOpen(true)}
      >
        {t("button")}
      </AIButton>
      <Modal.Backdrop className="z-[1099]" isOpen={isOpen} onOpenChange={setIsOpen}>
        <Modal.Container className="z-[1100]">
          <Modal.Dialog data-testid="clean-up-catalogue-dialog">
            <Modal.Header className="flex-row items-center gap-2">
              <SparklesIcon className={twMerge("size-5 shrink-0", cssAIIconColor)} />
              <Modal.Heading>{t("title")}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col">
              <p>{t("intro")}</p>
              {counts.data ? (
                <RadioGroup
                  aria-label={t("scopeLabel")}
                  value={scope}
                  variant="secondary"
                  onChange={(value) =>
                    setScope(value === "whole-catalogue" ? value : "recipe-foods")
                  }
                >
                  {SCOPES.map((option) => (
                    <Radio key={option} data-testid={`clean-up-scope-${option}`} value={option}>
                      <Radio.Content>
                        <Radio.Control>
                          <Radio.Indicator />
                        </Radio.Control>
                        <Label>{t(`scopes.${option}`)}</Label>
                      </Radio.Content>
                      <Description>{t(`scopes.${option}-description`)}</Description>
                    </Radio>
                  ))}
                </RadioGroup>
              ) : (
                <div className="flex justify-center pt-6 pb-2">
                  <Spinner size="sm" />
                </div>
              )}
              {counts.data && (
                <p className="text-muted tabular-nums" data-testid="clean-up-count">
                  {t("count", { count })}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onPress={() => setIsOpen(false)}>
                <XMarkIcon className="size-4" />
                {tActions("cancel")}
              </Button>
              <AIButton
                data-testid="clean-up-catalogue-start"
                isDisabled={count === 0}
                isPending={cleanUp.isPending}
                variant="secondary"
                onPress={() => cleanUp.mutate({ scope })}
              >
                {t("start")}
              </AIButton>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </SettingRow>
  );
}
