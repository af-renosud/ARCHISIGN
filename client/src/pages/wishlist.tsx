import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { wishlistCreateRequestSchema, type WishlistItem } from "@shared/schema";
import { z } from "zod";

type FormValues = z.infer<typeof wishlistCreateRequestSchema>;

const KIND_LABELS: Record<string, string> = { function: "New function", amendment: "Amendment" };
const STATUS_LABELS: Record<string, string> = {
  open: "Open", in_progress: "In progress", done: "Done", rejected: "Rejected",
};
const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  open: "secondary", in_progress: "default", done: "outline", rejected: "destructive",
};

export default function WishlistPage() {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);

  const { data: items, isLoading } = useQuery<WishlistItem[]>({
    queryKey: ["/api/wishlist"],
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(wishlistCreateRequestSchema),
    defaultValues: { title: "", description: "", kind: "function" },
  });

  const createMutation = useMutation({
    mutationFn: async (data: FormValues) => {
      const res = await apiRequest("POST", "/api/wishlist", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wishlist"] });
      form.reset({ title: "", description: "", kind: "function" });
      setIsCreating(false);
      toast({ title: "Request added", description: "Your wishlist item was saved." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/wishlist/${id}`, { status });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/wishlist"] }),
    onError: (err: Error) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/wishlist/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wishlist"] });
      toast({ title: "Request removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
    },
  });

  function onSubmit(values: FormValues) {
    createMutation.mutate(values);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold" data-testid="text-wishlist-title">Wishlist</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Capture requests for new functions and amendments to existing behaviour.
            </p>
          </div>
          {!isCreating && (
            <Button onClick={() => setIsCreating(true)} data-testid="button-new-wishlist-item">
              <Plus className="h-4 w-4 mr-2" />
              Add request
            </Button>
          )}
        </div>

        {isCreating && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">New request</CardTitle>
              <CardDescription>Describe the function or amendment you'd like.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Short summary of the request"
                            data-testid="input-wishlist-title"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="kind"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-wishlist-kind">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="function">New function</SelectItem>
                            <SelectItem value="amendment">Amendment</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Details (optional)</FormLabel>
                        <FormControl>
                          <Textarea
                            rows={4}
                            placeholder="What problem does this solve? Any context, screenshots, or examples?"
                            data-testid="input-wishlist-description"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => { setIsCreating(false); form.reset(); }}
                      data-testid="button-cancel-wishlist"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={createMutation.isPending}
                      data-testid="button-save-wishlist"
                    >
                      {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      Save request
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !items || items.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground" data-testid="text-wishlist-empty">
              No requests yet. Click "Add request" to log the first one.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <Card key={item.id} data-testid={`card-wishlist-${item.id}`}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium" data-testid={`text-wishlist-title-${item.id}`}>{item.title}</h3>
                        <Badge variant="outline" className="text-xs" data-testid={`badge-wishlist-kind-${item.id}`}>
                          {KIND_LABELS[item.kind] ?? item.kind}
                        </Badge>
                        <Badge
                          variant={STATUS_VARIANTS[item.status] ?? "secondary"}
                          className="text-xs"
                          data-testid={`badge-wishlist-status-${item.id}`}
                        >
                          {STATUS_LABELS[item.status] ?? item.status}
                        </Badge>
                      </div>
                      {item.description && (
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid={`text-wishlist-description-${item.id}`}>
                          {item.description}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {item.createdBy ? `${item.createdBy} · ` : ""}
                        {new Date(item.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={item.status}
                        onValueChange={(status) => updateMutation.mutate({ id: item.id, status })}
                      >
                        <SelectTrigger className="h-8 w-36" data-testid={`select-wishlist-status-${item.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="open">Open</SelectItem>
                          <SelectItem value="in_progress">In progress</SelectItem>
                          <SelectItem value="done">Done</SelectItem>
                          <SelectItem value="rejected">Rejected</SelectItem>
                        </SelectContent>
                      </Select>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            data-testid={`button-delete-wishlist-${item.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this request?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This permanently removes "{item.title}" from the wishlist.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate(item.id)}
                              data-testid={`button-confirm-delete-wishlist-${item.id}`}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
