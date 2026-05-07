import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";
import { useState, useEffect } from "react";
import type { Setting } from "@shared/schema";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export default function Settings() {
  const { toast } = useToast();

  const { data: settings, isLoading } = useQuery<Setting[]>({
    queryKey: ["/api/settings"],
  });

  const [formValues, setFormValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings) {
      const vals: Record<string, string> = {};
      for (const s of settings) {
        vals[s.key] = s.value;
      }
      setFormValues(vals);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (data: Setting[]) => {
      const res = await apiRequest("PUT", "/api/settings", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Settings saved", description: "Email templates will use the updated text." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save", description: error.message, variant: "destructive" });
    },
  });

  function handleSave() {
    if (!settings) return;
    const updated = settings.map((s) => ({
      ...s,
      value: formValues[s.key] ?? s.value,
    }));
    saveMutation.mutate(updated);
  }

  function updateValue(key: string, value: string) {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const emailSettings = settings?.filter((s) => s.category === "email") || [];
  const envelopeSettings = settings?.filter((s) => s.category === "envelope") || [];
  const placementValue = formValues["default_signature_placement_mode"] ?? "fixed_bottom_centre";

  const shortFields = ["firm_name", "email_invitation_subject_prefix", "email_footer_text"];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-settings-title">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure outbound email templates and platform preferences.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Email Copy Text</CardTitle>
            <CardDescription>
              These values are used in all outbound emails sent to signers. Changes apply to future emails only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {emailSettings.map((setting) => (
              <div key={setting.key} className="space-y-1.5">
                <Label htmlFor={setting.key} data-testid={`label-setting-${setting.key}`}>
                  {setting.label}
                </Label>
                {shortFields.includes(setting.key) ? (
                  <Input
                    id={setting.key}
                    value={formValues[setting.key] ?? ""}
                    onChange={(e) => updateValue(setting.key, e.target.value)}
                    data-testid={`input-setting-${setting.key}`}
                  />
                ) : (
                  <Textarea
                    id={setting.key}
                    value={formValues[setting.key] ?? ""}
                    onChange={(e) => updateValue(setting.key, e.target.value)}
                    rows={3}
                    data-testid={`input-setting-${setting.key}`}
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {envelopeSettings.find((s) => s.key === "default_signature_placement_mode") && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Envelope Defaults</CardTitle>
              <CardDescription>
                Pre-fill new envelopes with your firm's preferred signature placement. Admins can still override per envelope.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label data-testid="label-setting-default_signature_placement_mode">
                Default Signature Placement
              </Label>
              <RadioGroup
                value={placementValue}
                onValueChange={(v) => updateValue("default_signature_placement_mode", v)}
                className="grid gap-2"
              >
                <label
                  htmlFor="default-placement-fixed"
                  className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover-elevate"
                  data-testid="radio-default-placement-fixed_bottom_centre"
                >
                  <RadioGroupItem id="default-placement-fixed" value="fixed_bottom_centre" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Fixed (bottom centre)</p>
                    <p className="text-xs text-muted-foreground">
                      New envelopes are stamped automatically at the bottom centre of the last page.
                    </p>
                  </div>
                </label>
                <label
                  htmlFor="default-placement-admin"
                  className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover-elevate"
                  data-testid="radio-default-placement-admin_placed"
                >
                  <RadioGroupItem id="default-placement-admin" value="admin_placed" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Admin placed (free placement)</p>
                    <p className="text-xs text-muted-foreground">
                      New envelopes start in the field editor so you can drop fields anywhere on the document.
                    </p>
                  </div>
                </label>
              </RadioGroup>
            </CardContent>
          </Card>
        )}

        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            data-testid="button-save-settings"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}
