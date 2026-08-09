import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
console.log("bills:", (await sql`select count(*)::int as n from bills`)[0].n,
            " payments:", (await sql`select count(*)::int as n from payments`)[0].n);
console.log("sample bill numbers:", (await sql`select bill_no from bills order by created_at desc limit 4`).map(r => r.bill_no));
await sql.end();
