"use client";

import Link from "next/link";
import { useEffect, useState, use } from "react";
import { BottomNav, TopNav } from "@/components/BottomNav";
import { CustomerChip } from "@/components/CustomerChip";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { SubSwitchPill } from "@/components/SubSwitchPill";
import { SwitchAccountLink } from "@/components/SwitchAccount";
import { api, ApiClientError } from "@/lib/api-client";
import { T, useLang, useLangValue, usePageTitle } from "@/lib/i18n";
import { portalHref } from "@/lib/portal-link";
import type { CustomerProfile, OrderDetail } from "@/lib/types";

export default function OrderDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = use(params);
  const t = useLang();
  const lang = useLangValue();
  const dateLocale = lang === "es" ? "es-ES" : "en-US";
  usePageTitle({ en: "Order · LIT", es: "Pedido · LIT" });

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CustomerProfile>("/api/customer")
      .then(setCustomer)
      .catch(() => setCustomer(null));
    api<OrderDetail>(`/api/orders/${id}`)
      .then(setOrder)
      .catch((e: ApiClientError) => setError(e.code));
  }, [id]);

  if (error === "unauthorized" || error === "session_expired" || error === "session_invalid") {
    return <LoginScreen />;
  }
  if (error === "order_not_found") {
    return (
      <Frame customer={customer}>
        <div className="rounded-2xl bg-[color:var(--color-sharp-white)] px-6 py-10 text-center">
          <div className="text-[10px] font-bold uppercase tracking-[0.25em] opacity-60">
            <T en="Order" es="Pedido" />
          </div>
          <h1 className="mt-2 font-display text-3xl font-black uppercase">
            <T en="Not found" es="No encontrado" />
          </h1>
          <p className="mt-3 text-sm opacity-70">
            <T
              en="We couldn't find that order. It may belong to a different account."
              es="No pudimos encontrar ese pedido. Puede pertenecer a otra cuenta."
            />
          </p>
          <Link
            href={portalHref(lang, "account")}
            className="mt-6 inline-block rounded-sm bg-[color:var(--color-lit-grey)] px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)]"
          >
            <T en="Back to account" es="Volver a cuenta" />
          </Link>
          {/* The copy above has been naming the real cause since day one ("it may
              belong to a different account") while offering no way to act on it.
              This is the documented "Login with Shop" case: the order link in
              Shopify's own emails is correct, the customer is just signed into
              their other identity. 2026-07-29. */}
          <div className="mt-5">
            <SwitchAccountLink />
          </div>
        </div>
      </Frame>
    );
  }
  if (error) {
    return (
      <Frame customer={customer}>
        <div className="rounded-sm bg-red-50 px-4 py-3 text-xs text-red-700">
          <T en="Something went wrong." es="Algo no fue bien." /> ({error})
        </div>
      </Frame>
    );
  }
  if (!order) {
    return (
      <Frame customer={customer}>
        <div className="mt-6 animate-pulse rounded-2xl bg-[color:var(--color-sharp-white)] h-40" />
      </Frame>
    );
  }

  const cancelled = order.fulfillment?.status === "cancelled" || !!order.cancelledAt;
  const fulfilled = order.fulfillment?.status === "fulfilled";
  const inTransit = order.fulfillment?.status === "in_transit";

  return (
    <Frame customer={customer}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-6 md:px-0">
        <div>
          <Link
            href={portalHref(lang, "account")}
            className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-warm-gray)] hover:text-[color:var(--color-lit-grey)]"
          >
            ← <T en="Account" es="Cuenta" />
          </Link>
          <h1 className="mt-1 font-display text-3xl font-black uppercase leading-none text-[color:var(--color-lit-grey)] md:text-4xl">
            <T en="Order" es="Pedido" /> {order.orderNumber}
          </h1>
          <p className="mt-1 text-[11px] uppercase tracking-[0.15em] text-[color:var(--color-warm-gray)]">
            <T en="Confirmation date" es="Fecha de confirmación" />:{" "}
            {new Date(order.confirmationDate).toLocaleDateString(dateLocale, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
      </div>

      {/* Two-column layout on desktop */}
      <div className="mt-8 grid gap-5 px-6 md:grid-cols-[1fr_320px] md:px-0">
        {/* Left column: status + addresses */}
        <div className="space-y-4">
          {/* Status card */}
          <div
            className={`rounded-2xl border p-5 ${
              cancelled
                ? "border-red-200 bg-red-50/40"
                : fulfilled
                  ? "border-green-200 bg-green-50/40"
                  : "border-[color:var(--color-bold-yellow)]/40 bg-[color:var(--color-bold-yellow)]/15"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">
                  <T en="Status" es="Estado" />
                </div>
                <div className="mt-1 flex items-center gap-2 font-display text-xl font-black uppercase text-[color:var(--color-lit-grey)]">
                  {cancelled && (
                    <>
                      <span>✗</span>
                      <T en="Cancelled" es="Cancelado" />
                    </>
                  )}
                  {!cancelled && fulfilled && (
                    <>
                      <span>✓</span>
                      <T en="Delivered" es="Entregado" />
                    </>
                  )}
                  {!cancelled && inTransit && (
                    <>
                      <span>→</span>
                      <T en="In transit" es="En tránsito" />
                    </>
                  )}
                  {!cancelled && !fulfilled && !inTransit && (
                    <>
                      <span>⏱</span>
                      <T en="Processing" es="En proceso" />
                    </>
                  )}
                </div>
                {order.fulfillment?.shippedAt && (
                  <p className="mt-1 text-[11px] text-[color:var(--color-warm-gray)]">
                    <T en="Shipped on" es="Enviado el" />{" "}
                    {new Date(order.fulfillment.shippedAt).toLocaleDateString(dateLocale, {
                      day: "numeric",
                      month: "long",
                    })}
                  </p>
                )}
                {order.fulfillment?.deliveredAt && (
                  <p className="text-[11px] text-[color:var(--color-warm-gray)]">
                    <T en="Delivered on" es="Entregado el" />{" "}
                    {new Date(order.fulfillment.deliveredAt).toLocaleDateString(dateLocale, {
                      day: "numeric",
                      month: "long",
                    })}
                  </p>
                )}
                {order.cancelledAt && (
                  <p className="mt-1 text-[11px] text-[color:var(--color-warm-gray)]">
                    {new Date(order.cancelledAt).toLocaleDateString(dateLocale, {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </p>
                )}
              </div>
            </div>
            {order.fulfillment?.trackingUrl && (
              <a
                href={order.fulfillment.trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-2 rounded-sm bg-[color:var(--color-lit-grey)] px-5 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--color-bold-yellow)]"
              >
                <T en="Track shipment" es="Hacer seguimiento" /> →
              </a>
            )}
          </div>

          {/* Contact + addresses */}
          <div className="rounded-2xl bg-[color:var(--color-sharp-white)] p-5">
            <div className="grid gap-5 md:grid-cols-2">
              <Block label={t({ en: "Contact info", es: "Información de contacto" })}>
                <div className="font-bold">{order.contact.name}</div>
                <div className="text-[color:var(--color-warm-gray)]">{order.contact.email}</div>
                {order.contact.phone && (
                  <div className="text-[color:var(--color-warm-gray)]">{order.contact.phone}</div>
                )}
              </Block>

              {order.shippingAddress && (
                <Block label={t({ en: "Shipping address", es: "Dirección de envío" })}>
                  <AddressLines a={order.shippingAddress} />
                </Block>
              )}

              {order.billingAddress && (
                <Block label={t({ en: "Billing address", es: "Dirección de facturación" })}>
                  <AddressLines a={order.billingAddress} />
                </Block>
              )}

              {order.shippingMethodTitle && (
                <Block label={t({ en: "Shipping method", es: "Método de envío" })}>
                  <div className="text-[color:var(--color-lit-grey)]">
                    {order.shippingMethodTitle}
                  </div>
                </Block>
              )}
            </div>
          </div>
        </div>

        {/* Right column: items + totals */}
        <aside className="space-y-3 rounded-2xl bg-[color:var(--color-sharp-white)] p-5 md:sticky md:top-24 md:self-start">
          <ul className="space-y-3">
            {order.items.map((it) => (
              <li key={it.id} className="flex gap-3">
                {it.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.imageUrl}
                    alt={it.title}
                    className="h-14 w-14 flex-shrink-0 rounded-sm object-cover"
                  />
                ) : (
                  <div className="h-14 w-14 flex-shrink-0 rounded-sm bg-[color:var(--color-lit-grey)]/10" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-bold text-[color:var(--color-lit-grey)]">
                    {it.title}
                  </div>
                  {it.variantTitle && (
                    <div className="text-[11px] text-[color:var(--color-warm-gray)]">
                      {it.variantTitle}
                    </div>
                  )}
                  <div className="text-[11px] text-[color:var(--color-warm-gray)]">
                    × {it.quantity}
                  </div>
                </div>
                <div className="text-[12px] font-bold text-[color:var(--color-lit-grey)] whitespace-nowrap">
                  {(it.price * it.quantity).toFixed(2)} {order.currency}
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-4 space-y-1.5 border-t border-[color:var(--color-lit-grey)]/10 pt-4 text-[12px]">
            <Row
              label={t({ en: "Subtotal", es: "Subtotal" })}
              value={`${order.subtotal.toFixed(2)} ${order.currency}`}
            />
            <Row
              label={t({ en: "Shipping", es: "Envío" })}
              value={
                order.shippingPrice === 0
                  ? t({ en: "Free", es: "Gratis" })
                  : `${order.shippingPrice.toFixed(2)} ${order.currency}`
              }
            />
            {order.tax > 0 && (
              <Row
                label={t({ en: "Tax", es: "Impuestos" })}
                value={`${order.tax.toFixed(2)} ${order.currency}`}
              />
            )}
          </div>
          <div className="mt-3 flex items-baseline justify-between border-t border-[color:var(--color-lit-grey)]/10 pt-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
              <T en="Total" es="Total" />
            </div>
            <div className="font-display text-2xl font-black text-[color:var(--color-lit-grey)]">
              {order.total.toFixed(2)} {order.currency}
            </div>
          </div>
        </aside>
      </div>
    </Frame>
  );
}

function Frame({
  children,
  customer,
}: {
  children: React.ReactNode;
  customer: CustomerProfile | null;
}) {
  return (
    <div className="zone-cream mesh-bg flex min-h-screen flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
      <TopNav />

      <header className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between border-b border-[color:var(--color-lit-grey)]/8 bg-[color:var(--color-brisky-cream)]/90 px-6 pt-5 pb-3 backdrop-blur-md md:hidden">
        <Logo />
        {/* Multi-sub switch + min-w-0 overflow guard, mirroring the Hub and
            Account mobile headers (audit 2026-07-08: the pill was missing
            here, so a multi-sub customer on mobile couldn't switch subs from
            the order detail). The Frame wraps loading/error/loaded alike, so
            every state gets the same header. */}
        <div className="flex min-w-0 items-center gap-2.5">
          <SubSwitchPill />
          {customer && <CustomerChip name={customer.name} />}
        </div>
      </header>

      <main className="flex-1 pt-[88px] pb-24 md:mx-auto md:w-full md:max-w-5xl md:px-8 md:pt-[92px] md:pb-12">
        {children}
      </main>

      <BottomNav />
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.22em] opacity-60">{label}</div>
      <div className="mt-1.5 text-[12px] leading-relaxed">{children}</div>
    </div>
  );
}

function AddressLines({
  a,
}: {
  a: {
    firstName: string;
    lastName: string;
    address1: string;
    address2: string | null;
    city: string;
    postalCode: string;
    province: string | null;
    country: string;
    phone: string | null;
  };
}) {
  return (
    <>
      <div className="font-bold text-[color:var(--color-lit-grey)]">
        {[a.firstName, a.lastName].filter(Boolean).join(" ")}
      </div>
      <div className="text-[color:var(--color-warm-gray)]">{a.address1}</div>
      {a.address2 && <div className="text-[color:var(--color-warm-gray)]">{a.address2}</div>}
      <div className="text-[color:var(--color-warm-gray)]">
        {a.postalCode} {a.city}
      </div>
      {a.province && <div className="text-[color:var(--color-warm-gray)]">{a.province}</div>}
      <div className="text-[color:var(--color-warm-gray)]">{a.country}</div>
      {a.phone && <div className="text-[color:var(--color-warm-gray)]">{a.phone}</div>}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="opacity-60">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}
