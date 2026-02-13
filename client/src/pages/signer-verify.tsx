import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { FileText, ShieldCheck, Mail, ArrowRight, Lock } from "lucide-react";

type SignerInfo = {
  signerName: string;
  signerEmail: string;
  envelopeSubject: string;
  verified: boolean;
  signed: boolean;
};

export default function SignerVerify() {
  const { token } = useParams<{ token: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [otpValue, setOtpValue] = useState("");
  const [otpSent, setOtpSent] = useState(false);

  const { data: signerInfo, isLoading } = useQuery<SignerInfo>({
    queryKey: ["/api/sign", token, "info"],
    queryFn: async () => {
      const res = await fetch(`/api/sign/${token}/info`);
      if (!res.ok) throw new Error("Invalid or expired link");
      return res.json();
    },
    enabled: !!token,
  });

  const requestOtpMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sign/${token}/request-otp`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to send verification code");
      return res.json();
    },
    onSuccess: () => {
      setOtpSent(true);
      toast({ title: "Code sent", description: "Check your email for the verification code." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const verifyOtpMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch(`/api/sign/${token}/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Invalid code");
      }
      return res.json();
    },
    onSuccess: () => {
      navigate(`/sign/${token}/document`);
    },
    onError: (err: Error) => {
      toast({ title: "Verification failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 space-y-4">
            <Skeleton className="h-12 w-12 rounded-md mx-auto" />
            <Skeleton className="h-6 w-48 mx-auto" />
            <Skeleton className="h-4 w-64 mx-auto" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!signerInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-destructive/10 mx-auto">
              <Lock className="h-6 w-6 text-destructive" />
            </div>
            <h2 className="text-lg font-semibold">Invalid Link</h2>
            <p className="text-sm text-muted-foreground">
              This signing link is invalid or has expired. Please contact the sender for a new link.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (signerInfo.verified || signerInfo.signed) {
    if (signerInfo.signed) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
          <Card className="w-full max-w-md">
            <CardContent className="p-8 text-center space-y-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-green-100 dark:bg-green-900/20 mx-auto">
                <ShieldCheck className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <h2 className="text-lg font-semibold">Already Signed</h2>
              <p className="text-sm text-muted-foreground">
                You have already signed "{signerInfo.envelopeSubject}".
              </p>
            </CardContent>
          </Card>
        </div>
      );
    }
    navigate(`/sign/${token}/document`);
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-8 space-y-6">
          <div className="text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-primary/10 mx-auto">
              <FileText className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold" data-testid="text-verify-title">Document Signing</h2>
              <p className="text-sm text-muted-foreground mt-1" data-testid="text-verify-subject">
                {signerInfo.envelopeSubject}
              </p>
            </div>
          </div>

          <div className="space-y-1 text-center">
            <p className="text-sm">
              Hello <span className="font-medium">{signerInfo.signerName}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              To verify your identity, we'll send a one-time code to your email
            </p>
            <p className="text-sm font-medium">{maskEmail(signerInfo.signerEmail)}</p>
          </div>

          {!otpSent ? (
            <Button
              className="w-full"
              onClick={() => requestOtpMutation.mutate()}
              disabled={requestOtpMutation.isPending}
              data-testid="button-request-otp"
            >
              <Mail className="h-4 w-4 mr-2" />
              {requestOtpMutation.isPending ? "Sending..." : "Send Verification Code"}
            </Button>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  value={otpValue}
                  onChange={setOtpValue}
                  data-testid="input-otp"
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <Button
                className="w-full"
                onClick={() => verifyOtpMutation.mutate(otpValue)}
                disabled={otpValue.length !== 6 || verifyOtpMutation.isPending}
                data-testid="button-verify-otp"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                {verifyOtpMutation.isPending ? "Verifying..." : "Verify & Continue"}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setOtpValue("");
                  requestOtpMutation.mutate();
                }}
                disabled={requestOtpMutation.isPending}
                data-testid="button-resend-otp"
              >
                Resend Code
              </Button>
            </div>
          )}

          <p className="text-xs text-center text-muted-foreground">
            Secured by Archisign. Your identity is verified via email.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}${"*".repeat(Math.min(local.length - 2, 5))}@${domain}`;
}
