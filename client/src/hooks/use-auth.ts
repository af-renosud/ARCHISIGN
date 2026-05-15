import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { User } from "@shared/models/auth";

async function fetchUser(): Promise<User | null> {
  const response = await fetch("/api/auth/user", {
    credentials: "include",
  });

  if (response.status === 401) {
    return null;
  }

  // 403 means the admin guard rejected the session (wrong domain or not on
  // the allowlist). Surface a flag the login page can read, then treat the
  // user as logged out so the login screen is shown.
  if (response.status === 403) {
    try {
      const body = await response.clone().json();
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          "archisign:auth-denied",
          JSON.stringify({
            code: body?.code ?? "access_denied",
            message: body?.message ?? "Access denied.",
            allowedDomain: body?.allowedDomain ?? null,
          }),
        );
      }
    } catch {
      // Ignore body parse failures; the login page falls back to a
      // generic message.
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          "archisign:auth-denied",
          JSON.stringify({ code: "access_denied", message: "Access denied." }),
        );
      }
    }
    return null;
  }

  if (!response.ok) {
    throw new Error(`${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function logout(): Promise<void> {
  window.location.href = "/api/logout";
}

export function useAuth() {
  const queryClient = useQueryClient();
  const { data: user, isLoading } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: fetchUser,
    retry: false,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/user"], null);
    },
  });

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    logout: logoutMutation.mutate,
    isLoggingOut: logoutMutation.isPending,
  };
}
