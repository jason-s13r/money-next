import { requireUser } from "@/lib/server/auth/session";
import { buildInfo } from "@/lib/server/build-info";
import { AccountSidebar } from "@/ui/chrome/account-sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

/**
 * Chrome for the account area.
 *
 * The account pages sit above `/w/[workspace]/` and so never got the app's left
 * rail — which left /account a dead end with no way back into the app. This
 * layout gives them a *user-scoped* sidebar instead (ui/chrome/account-sidebar):
 * the same branding, the account destinations, and a link back to `/`. It needs
 * only `requireUser` — a session, no workspace — so it holds for a member and
 * for someone with no workspace at all, the same guarantee the pages beneath it
 * make. There is no `requireWorkspace` here because there is deliberately no
 * workspace in the URL to resolve.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AccountSidebar
          user={{ name: user.name, email: user.email }}
          build={buildInfo()}
        />
        <SidebarInset>
          <header className="sticky top-0 z-40 flex items-center gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="h-6 data-[orientation=vertical]:self-center"
            />
            <span className="text-sm font-medium">Account</span>
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
