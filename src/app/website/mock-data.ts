/* ---------------------------------------------------------------------------
 * Mock content for the Website app.
 *
 * Every row here is in-memory only — nothing here is read from or written to
 * a database, and nothing here reaches mahek-website. That is deliberate: this
 * PR wires up the app, its access and its 12 module screens; a CMS that
 * actually drives the public site is a later PR, with its own tables and its
 * own migration. The shapes below are what that schema will eventually look
 * like, which is why they are typed rather than left as loose objects.
 * ------------------------------------------------------------------------- */

export type Status = "published" | "draft" | "archived";

export type Product = {
  id: string;
  slug: string;
  name: string;
  category: string;
  status: Status;
  description: string;
  updatedAt: string;
};

export const PRODUCTS: Product[] = [
  { id: "p1", slug: "universal-thinner", name: "Universal Thinner", category: "Thinners", status: "published", description: "A general-purpose thinner for a wide range of paint systems.", updatedAt: "2026-09-02" },
  { id: "p2", slug: "nc-thinner", name: "NC Thinner", category: "Thinners", status: "published", description: "Fast-drying thinner for nitrocellulose lacquers.", updatedAt: "2026-09-02" },
  { id: "p3", slug: "pu-thinner", name: "PU Thinner", category: "Thinners", status: "published", description: "Formulated for polyurethane coatings.", updatedAt: "2026-08-21" },
  { id: "p4", slug: "nano-thinner", name: "Nano Thinner", category: "Thinners", status: "published", description: "A refined thinner for high-finish nano coatings.", updatedAt: "2026-08-21" },
  { id: "p5", slug: "mylac-135-melamine-thinner", name: "Mylac-135 Melamine Thinner", category: "Thinners", status: "draft", description: "For melamine-based wood finishes.", updatedAt: "2026-09-18" },
  { id: "p6", slug: "mahek-epoxy-thinner", name: "Mahek Epoxy Thinner", category: "Thinners", status: "draft", description: "Pairs with epoxy primers and floor coatings.", updatedAt: "2026-09-18" },
  { id: "p7", slug: "mahek-polish-thinner-m1433", name: "Mahek Polish Thinner M1433", category: "Polish", status: "published", description: "A polish-grade thinner, product code M1433.", updatedAt: "2026-07-30" },
  { id: "p8", slug: "mahek-mild-cleaner-m164", name: "Mahek Mild Cleaner M164", category: "Cleaners", status: "published", description: "A mild surface cleaner, product code M164.", updatedAt: "2026-07-30" },
  { id: "p9", slug: "enamel-gp-thinner", name: "Enamel & G.P. Thinner", category: "Thinners", status: "archived", description: "General-purpose thinner for enamel paints.", updatedAt: "2026-05-14" },
];

export type Industry = {
  id: string;
  slug: string;
  name: string;
  status: Status;
  description: string;
  updatedAt: string;
};

export const INDUSTRIES: Industry[] = [
  { id: "i1", slug: "paint-industry", name: "Paint Industry", status: "published", description: "Thinners and additives for paint manufacturers.", updatedAt: "2026-08-10" },
  { id: "i2", slug: "furniture", name: "Furniture", status: "published", description: "Finishing solvents for furniture and wood coatings.", updatedAt: "2026-08-10" },
  { id: "i3", slug: "automobile", name: "Automobile", status: "published", description: "Refinish and OEM coating solvents.", updatedAt: "2026-08-04" },
  { id: "i4", slug: "cleaning-industry", name: "Cleaning Industry", status: "draft", description: "Mild cleaners and degreasers.", updatedAt: "2026-09-21" },
];

export type GalleryItem = {
  id: string;
  title: string;
  category: string;
  status: Status;
  updatedAt: string;
};

export const GALLERY: GalleryItem[] = [
  { id: "g1", title: "Manufacturing floor, Line 2", category: "Facility", status: "published", updatedAt: "2026-06-11" },
  { id: "g2", title: "Drum filling station", category: "Facility", status: "published", updatedAt: "2026-06-11" },
  { id: "g3", title: "Quality lab", category: "Facility", status: "published", updatedAt: "2026-05-29" },
  { id: "g4", title: "Distributor meet, Surat", category: "Events", status: "draft", updatedAt: "2026-09-25" },
  { id: "g5", title: "Loading bay", category: "Facility", status: "published", updatedAt: "2026-04-02" },
];

export type MediaItem = {
  id: string;
  filename: string;
  kind: "image" | "document";
  usedBy: string;
  updatedAt: string;
};

export const MEDIA: MediaItem[] = [
  { id: "m1", filename: "universal-thinner-hero.jpg", kind: "image", usedBy: "Products", updatedAt: "2026-09-02" },
  { id: "m2", filename: "manufacturing-floor.jpg", kind: "image", usedBy: "Gallery", updatedAt: "2026-06-11" },
  { id: "m3", filename: "m1433-datasheet.pdf", kind: "document", usedBy: "Products", updatedAt: "2026-07-30" },
  { id: "m4", filename: "company-profile.pdf", kind: "document", usedBy: "About page", updatedAt: "2026-03-14" },
];

export type Job = {
  id: string;
  title: string;
  department: string;
  location: string;
  status: Status;
  updatedAt: string;
};

export const JOBS: Job[] = [
  { id: "j1", title: "Production Supervisor", department: "Manufacturing", location: "Ankleshwar", status: "published", updatedAt: "2026-09-10" },
  { id: "j2", title: "Quality Control Chemist", department: "Quality", location: "Ankleshwar", status: "published", updatedAt: "2026-09-10" },
  { id: "j3", title: "Area Sales Executive", department: "Sales", location: "Ahmedabad", status: "draft", updatedAt: "2026-09-27" },
];

export type Testimonial = {
  id: string;
  author: string;
  company: string;
  status: Status;
  quote: string;
  updatedAt: string;
};

export const TESTIMONIALS: Testimonial[] = [
  { id: "t1", author: "Rakesh Shah", company: "Shah Paints", status: "published", quote: "Consistent quality, every batch.", updatedAt: "2026-08-15" },
  { id: "t2", author: "Meena Furnishings", company: "Meena Furnishings", status: "published", quote: "Our go-to thinner supplier for six years.", updatedAt: "2026-08-15" },
  { id: "t3", author: "Patel Auto Refinish", company: "Patel Auto Refinish", status: "draft", quote: "Reliable supply, fair pricing.", updatedAt: "2026-09-30" },
];

export type Milestone = {
  id: string;
  year: string;
  title: string;
  status: Status;
  updatedAt: string;
};

export const MILESTONES: Milestone[] = [
  { id: "ms1", year: "1998", title: "Mahek founded in Ankleshwar", status: "published", updatedAt: "2026-02-01" },
  { id: "ms2", year: "2008", title: "First distributor network across Gujarat", status: "published", updatedAt: "2026-02-01" },
  { id: "ms3", year: "2017", title: "New manufacturing line commissioned", status: "published", updatedAt: "2026-02-01" },
  { id: "ms4", year: "2026", title: "Pan-India distribution reaches 12 states", status: "draft", updatedAt: "2026-10-01" },
];

export type NavItem = { id: string; label: string; href: string };
export type NavGroup = "header" | "footer-company" | "footer-quick" | "footer-legal";

export const NAV: Record<NavGroup, NavItem[]> = {
  header: [
    { id: "n1", label: "Home", href: "/" },
    { id: "n2", label: "Products", href: "/products" },
    { id: "n3", label: "Industries", href: "/industries" },
    { id: "n4", label: "Contact", href: "/contact" },
  ],
  "footer-company": [
    { id: "n5", label: "About Us", href: "/about" },
    { id: "n6", label: "Manufacturing", href: "/manufacturing" },
    { id: "n7", label: "Careers", href: "/careers" },
  ],
  "footer-quick": [
    { id: "n8", label: "Products", href: "/products" },
    { id: "n9", label: "Distributor Enquiry", href: "/distributor" },
  ],
  "footer-legal": [
    { id: "n10", label: "Privacy Policy", href: "/privacy" },
    { id: "n11", label: "Terms of Service", href: "/terms" },
  ],
};

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  header: "Header",
  "footer-company": "Footer — Company",
  "footer-quick": "Footer — Quick links",
  "footer-legal": "Footer — Legal",
};

export type PageSection = { id: string; heading: string; status: Status };
export type SitePage = { id: string; slug: string; title: string; sections: PageSection[] };

export const PAGES: SitePage[] = [
  {
    id: "pg1",
    slug: "about",
    title: "About",
    sections: [
      { id: "s1", heading: "Our story", status: "published" },
      { id: "s2", heading: "Leadership", status: "published" },
    ],
  },
  {
    id: "pg2",
    slug: "manufacturing",
    title: "Manufacturing",
    sections: [
      { id: "s3", heading: "Facility overview", status: "published" },
      { id: "s4", heading: "Quality process", status: "draft" },
    ],
  },
  {
    id: "pg3",
    slug: "distributor",
    title: "Distributor",
    sections: [{ id: "s5", heading: "Why partner with Mahek", status: "published" }],
  },
  {
    id: "pg4",
    slug: "contact",
    title: "Contact",
    sections: [{ id: "s6", heading: "Reach us", status: "published" }],
  },
];

export const SETTINGS = {
  company: { name: "Mahek Chemicals", tagline: "Thinners, cleaners and coatings solvents since 1998" },
  stats: { yearsInBusiness: "27+", distributors: "150+", statesServed: "12" },
  social: { facebook: "https://facebook.com/mahek", instagram: "https://instagram.com/mahek" },
  contact: { phone: "+91 98765 43210", email: "sales@mahekchemicals.com" },
  analytics: { gaId: "G-XXXXXXXXXX" },
  seo: { defaultTitle: "Mahek Chemicals", defaultDescription: "Thinners, cleaners and coatings solvents." },
};
