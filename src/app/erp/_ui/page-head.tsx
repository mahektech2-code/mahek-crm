/* The design's page header: crumb, title and one line under it. List screens
   draw their own (with Export / Download / New); these pages have none. */
export function PageHead({ crumb, title, sub }: { crumb: string; title: string; sub?: string }) {
  return (
    <div style={{ padding: "18px 24px 14px 24px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0, flex: "1 1 360px" }}>
        <div style={{ fontSize: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", color: "#6B7385" }}>{crumb}</div>
        <h1 style={{ fontSize: 24, lineHeight: "30px", fontWeight: 600, color: "#161616", marginTop: 2 }}>{title}</h1>
        {sub ? <div style={{ fontSize: 14, color: "#6B7385", marginTop: 2, maxWidth: 760, textWrap: "pretty" }}>{sub}</div> : null}
      </div>

    </div>
  );
}

export function PageBody({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "0 24px 48px 24px" }}>{children}</div>;
}
