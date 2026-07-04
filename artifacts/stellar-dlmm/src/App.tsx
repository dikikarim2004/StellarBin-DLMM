import { useState } from "react";
import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Activity, BarChart3, LayoutDashboard, ArrowLeftRight, Menu } from "lucide-react";
import NotFound from "@/pages/not-found";
import SwapPage from "@/pages/swap";
import PoolsPage from "@/pages/pools";
import PoolDetailPage from "@/pages/pool-detail";
import PositionsPage from "@/pages/positions";
import AnalyticsPage from "@/pages/analytics";
import { WalletProvider } from "@/contexts/wallet";
import { WalletModal, HeaderWalletButton } from "@/components/wallet-modal";

const queryClient = new QueryClient();

const NAV_ITEMS = [
  { href: "/swap", label: "Swap", icon: ArrowLeftRight },
  { href: "/pools", label: "Pools", icon: LayoutDashboard },
  { href: "/positions", label: "Positions", icon: Activity },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

function Logo() {
  return (
    <Link href="/swap" className="flex items-center gap-2.5 shrink-0" data-testid="link-logo">
      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
        <div className="w-4 h-4 rounded-full border-2 border-primary-foreground" />
      </div>
      <span className="font-bold text-lg tracking-tight whitespace-nowrap">StellarBin</span>
    </Link>
  );
}

function DesktopNav() {
  const [location] = useLocation();
  return (
    <nav className="hidden md:flex items-center gap-1">
      {NAV_ITEMS.map((item) => {
        const isActive = location.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`px-3.5 py-2 rounded-full text-sm font-medium transition-colors ${
              isActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
            }`}
            data-testid={`link-nav-${item.label.toLowerCase()}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function MobileNav({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [location] = useLocation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-72 bg-card border-border p-0 flex flex-col">
        <div className="p-5 border-b border-border">
          <Logo />
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = location.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => onOpenChange(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                data-testid={`link-mobile-nav-${item.label.toLowerCase()}`}
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-border text-xs text-muted-foreground text-center pb-4">
          Connected to Stellar Testnet
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Header() {
  const [walletOpen, setWalletOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 h-16 flex items-center gap-3">
          <button
            className="md:hidden w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors shrink-0"
            onClick={() => setMobileNavOpen(true)}
            data-testid="button-open-mobile-nav"
          >
            <Menu className="w-5 h-5" />
          </button>

          <Logo />

          <div className="flex-1 flex justify-center">
            <DesktopNav />
          </div>

          <div className="ml-auto md:ml-0 shrink-0">
            <HeaderWalletButton onOpen={() => setWalletOpen(true)} />
          </div>
        </div>

        {/* Bottom tab bar for mobile — quick access without opening the drawer */}
        <div className="md:hidden border-t border-border flex overflow-x-auto no-scrollbar">
          <MobileTabs />
        </div>
      </header>

      <MobileNav open={mobileNavOpen} onOpenChange={setMobileNavOpen} />
      <WalletModal open={walletOpen} onOpenChange={setWalletOpen} />
    </>
  );
}

function MobileTabs() {
  const [location] = useLocation();
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = location.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-xs font-medium min-w-[72px] border-b-2 transition-colors ${
              isActive
                ? "text-primary border-primary"
                : "text-muted-foreground border-transparent"
            }`}
            data-testid={`link-tab-${item.label.toLowerCase()}`}
          >
            <Icon className="w-4 h-4" />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <Header />
      <main>
        <div className="max-w-7xl mx-auto p-4 sm:p-6 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={() => {
          const [, setLocation] = useLocation();
          setLocation("/swap");
          return null;
        }} />
        <Route path="/swap" component={SwapPage} />
        <Route path="/pools" component={PoolsPage} />
        <Route path="/pools/:poolId" component={PoolDetailPage} />
        <Route path="/positions" component={PositionsPage} />
        <Route path="/analytics" component={AnalyticsPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WalletProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </WalletProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
