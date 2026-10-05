/* ---------------------------------------------------------------------------
 * Website Admin — PROTOTYPE mock data.
 *
 * Nothing here touches a database. This module exists so every Website Admin
 * screen has realistic, in-memory data to render and mutate for the
 * duration of a browser session — content mirrors the real public website's
 * actual products/industries/copy (mahek-website's src/data/*.ts), so this
 * prototype reads as Mahek's own admin rather than a generic demo.
 *
 * Replacing this file with real reads from the CRM database is the whole of
 * what a later, separate implementation phase does — no screen in this
 * module should need to change shape to make that swap.
 * ------------------------------------------------------------------------- */

export type ContentStatus = "draft" | "published" | "archived";

export type StampFields = {
  updatedAt: string;
  updatedBy: string;
  publishedAt?: string;
  publishedBy?: string;
};

export type WebsiteProduct = StampFields & {
  id: string;
  name: string;
  slug: string;
  tag: string;
  status: ContentStatus;
  displayOrder: number;
  shortDescription: string;
  longDescription: string;
  applications: string[];
  benefits: string[];
  packaging: string[];
  specs: { label: string; value: string }[];
  images: { id: string; label: string; alt: string }[];
  industries: string[];
  seo: {
    title: string;
    description: string;
    canonical: string;
    ogImage: string | null;
  };
};

export type WebsiteIndustry = StampFields & {
  id: string;
  name: string;
  slug: string;
  status: ContentStatus;
  displayOrder: number;
  shortDescription: string;
  image: string | null;
  productSlugs: string[];
  seo: { title: string; description: string; canonical: string };
};

export type GalleryItem = StampFields & {
  id: string;
  category: string;
  label: string;
  image: string;
  alt: string;
  status: ContentStatus;
  displayOrder: number;
};

export type JobPosting = StampFields & {
  id: string;
  title: string;
  department: string;
  location: string;
  type: string;
  description: string;
  status: "draft" | "open" | "closed";
  createdAt: string;
};

export type Testimonial = StampFields & {
  id: string;
  name: string;
  role: string;
  company: string;
  quote: string;
  initials: string;
  status: ContentStatus;
  displayOrder: number;
};

export type Milestone = {
  id: string;
  year: string;
  title: string;
  description: string;
  displayOrder: number;
};

export type NavItem = {
  id: string;
  group: "header" | "footer-company" | "footer-quick" | "footer-legal" | "manufacturing-mega";
  label: string;
  href: string;
  displayOrder: number;
  visible: boolean;
};

export type MediaAsset = {
  id: string;
  filename: string;
  alt: string;
  contentType: string;
  sizeKb: number;
  width: number;
  height: number;
  uploadedAt: string;
  uploadedBy: string;
  usedBy: string[];
};

export type PageSection = {
  key: string;
  label: string;
  fields: { key: string; label: string; type: "text" | "textarea"; value: string }[];
};

export type WebsitePage = StampFields & {
  key: string;
  name: string;
  route: string;
  status: ContentStatus;
  sections: PageSection[];
  seo: { title: string; description: string; canonical: string };
};

/* ------------------------------------------------------------------ people */

export const ADMIN_USERS = ["Rahul Shah", "Seema Kulkarni", "Vikram Doshi", "Admin"];

/* --------------------------------------------------------------- products */

export const INITIAL_PRODUCTS: WebsiteProduct[] = [
  {
    id: "prod_universal",
    name: "Mahek Universal Thinner",
    slug: "universal-thinner",
    tag: "Best Seller",
    status: "published",
    displayOrder: 1,
    shortDescription: "One Thinner for all your painting needs",
    longDescription:
      "Mahek Universal Thinner is a premium-grade, bloom-resistant thinner with a medium to fast-drying formulation that delivers excellent gloss and self-leveling finishes, suitable for enamel, acrylic, automotive paints, primers, lacquers and wood finishes.",
    applications: ["Synthetic Enamel", "Metal Primer", "Wood Polish", "PU paints", "Epoxy paints"],
    benefits: ["Fast Drying", "Glossy Finish", "Low Odor", "Tested Quality", "Multi-purpose Use"],
    packaging: ["500ml", "1L", "5L", "10L", "20L", "20L Tin"],
    specs: [
      { label: "Appearance", value: "Crystal Clear" },
      { label: "Odor", value: "Fruity Smell" },
      { label: "Drying Time", value: "Medium to Fast" },
      { label: "Specific Gravity", value: "0.86 ± 0.05" },
    ],
    images: [{ id: "m1", label: "Combo", alt: "Mahek Universal Thinner Combo pack" }],
    industries: ["Auto Paints", "Furniture Polish", "Car Colors"],
    seo: {
      title: "Mahek Universal Thinner | Industrial Thinners",
      description: "One Thinner for all your painting needs — premium bloom-resistant formulation.",
      canonical: "/products/universal-thinner",
      ogImage: "m1",
    },
    updatedAt: "2026-09-28T10:12:00+05:30",
    updatedBy: "Rahul Shah",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "prod_nc",
    name: "Mahek NC Thinner",
    slug: "nc-thinner",
    tag: "Industrial Grade",
    status: "published",
    displayOrder: 2,
    shortDescription: "Precision Formulated for Perfect Flow & Finish.",
    longDescription:
      "A specially formulated blend for reducing the viscosity of lacquer paints, wood polishes and automotive coatings — quick-drying, low in odor, and bloom-resistant.",
    applications: ["Cleaning Spray Guns, Rollers, and Brushes", "Synthetic Enamel", "Metal Primer"],
    benefits: ["Fast Drying", "Glossy Finish", "Low Odor", "Multi-Purpose Use"],
    packaging: ["500ml", "1L", "5L", "10L", "20L"],
    specs: [
      { label: "Appearance", value: "Clear, colourless liquid" },
      { label: "Odor", value: "Sweet & Strong" },
    ],
    images: [{ id: "m2", label: "Combo", alt: "Mahek NC Thinner Combo pack" }],
    industries: ["Decorative Paints", "Hardware Shops", "Furniture"],
    seo: {
      title: "Mahek NC Thinner | Industrial Thinners",
      description: "Precision formulated NC Thinner for perfect flow and finish.",
      canonical: "/products/nc-thinner",
      ogImage: "m2",
    },
    updatedAt: "2026-09-20T14:30:00+05:30",
    updatedBy: "Seema Kulkarni",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "prod_pu",
    name: "Mahek PU Thinner",
    slug: "pu-thinner",
    tag: "Premium",
    status: "published",
    displayOrder: 3,
    shortDescription: "Premium Polyurethane Thinner for Professional Finishes.",
    longDescription:
      "A high-performance thinner formulated for thinning P.U. paints — ideal for solvent-based polyurethane sealers, primers, clear, melamine, and pigmented topcoats.",
    applications: ["P.U. Melamine & Sealers", "PU Wood Polish", "PU Paints"],
    benefits: ["Specially formulated for PU paints", "Superior paint consistency"],
    packaging: ["1L", "5L", "20L", "1L Tin", "20L Tin"],
    specs: [{ label: "Appearance", value: "Crystal Clear" }],
    images: [{ id: "m3", label: "Combo", alt: "Mahek PU Thinner Combo pack" }],
    industries: ["Auto Paints", "Furniture Polish"],
    seo: {
      title: "Mahek PU Thinner | Industrial Thinners",
      description: "Premium polyurethane thinner for professional finishes.",
      canonical: "/products/pu-thinner",
      ogImage: "m3",
    },
    updatedAt: "2026-09-02T11:00:00+05:30",
    updatedBy: "Rahul Shah",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "prod_nano",
    name: "Mahek Nano Thinner",
    slug: "nano-thinner",
    tag: "General Purpose",
    status: "published",
    displayOrder: 4,
    shortDescription: "Premium Quality, Multipurpose Performance.",
    longDescription:
      "Designed for superior cleaning and thinning performance in paints and primers — fast-drying, low odor, eco-conscious formulation.",
    applications: ["Cleaning Spray Guns, Rollers, and Brushes", "Synthetic Enamel"],
    benefits: ["Fast Drying", "Glossy Finish", "Low Odor"],
    packaging: ["500ml", "1L", "5L", "10L", "20L"],
    specs: [{ label: "Appearance", value: "Clear, water-white liquid" }],
    images: [{ id: "m4", label: "Combo", alt: "Mahek Nano Thinner Combo pack" }],
    industries: ["Auto Paints", "Furniture Polish", "Hardware"],
    seo: {
      title: "Mahek Nano Thinner | Industrial Thinners",
      description: "Premium quality, multipurpose thinning performance.",
      canonical: "/products/nano-thinner",
      ogImage: "m4",
    },
    updatedAt: "2026-08-15T09:45:00+05:30",
    updatedBy: "Vikram Doshi",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "prod_mylac",
    name: "Mylac-135 Melamine Thinner",
    slug: "mylac-135-melamine-thinner",
    tag: "Premium",
    status: "draft",
    displayOrder: 5,
    shortDescription: "Delivers smooth flow, excellent leveling, and lasting gloss at cost-effective pricing.",
    longDescription:
      "A premium solvent-based reducing agent designed to provide ideal viscosity for melamine paints and polishes — real product details pending final confirmation before publish.",
    applications: ["Polish", "Melamyne", "Lac Dana"],
    benefits: ["Fast Drying", "Glossy Finish"],
    packaging: ["1L", "5L", "20L"],
    specs: [{ label: "Appearance", value: "Clear, water-white liquid" }],
    images: [],
    industries: ["Decorative Paints", "Hardware Shops", "Furniture"],
    seo: { title: "", description: "", canonical: "/products/mylac-135-melamine-thinner", ogImage: null },
    updatedAt: "2026-09-29T16:00:00+05:30",
    updatedBy: "Seema Kulkarni",
  },
  {
    id: "prod_epoxy",
    name: "Mahek Epoxy Thinner",
    slug: "mahek-epoxy-thinner",
    tag: "Premium",
    status: "draft",
    displayOrder: 6,
    shortDescription: "Engineered for Superior Finish & Durability.",
    longDescription:
      "A carefully formulated solvent blend designed to thin epoxy paints and clean application tools — pending final review before publish.",
    applications: ["Epoxy Primer", "Epoxy Flooring", "Epoxy Paints"],
    benefits: ["Fast Drying", "Glossy Finish"],
    packaging: ["1L", "5L", "20L", "20L Tin"],
    specs: [{ label: "Appearance", value: "Crystal Clear" }],
    images: [],
    industries: ["Industrial Counters"],
    seo: { title: "", description: "", canonical: "/products/mahek-epoxy-thinner", ogImage: null },
    updatedAt: "2026-09-27T12:00:00+05:30",
    updatedBy: "Seema Kulkarni",
  },
  {
    id: "prod_m1433",
    name: "Mahek Polish Thinner M1433",
    slug: "mahek-polish-thinner-m1433",
    tag: "Polish",
    status: "published",
    displayOrder: 7,
    shortDescription: "Crystal-Clean Performance for Every Polish",
    longDescription:
      "Specially formulated for removing sealants, oil, grease, wax, and paint residues — powerful cleaning and degreasing, evaporates quickly without residue.",
    applications: ["Cleaning Spray Guns, Rollers, and Brushes", "Wood Cleaning", "Wood Polish", "Metal Cleaning"],
    benefits: ["Fast Drying", "Sweet Fruity Smell", "Crystal Clear"],
    packaging: ["1L", "5L", "20L"],
    specs: [{ label: "Appearance", value: "Crystal Clear" }],
    images: [{ id: "m7", label: "1433", alt: "Mahek M1433 Polish Thinner" }],
    industries: ["Industrial Counters", "Hardware Shops"],
    seo: {
      title: "Mahek Polish Thinner M1433 | Industrial Thinners",
      description: "Crystal-clean performance for every polish.",
      canonical: "/products/mahek-polish-thinner-m1433",
      ogImage: "m7",
    },
    updatedAt: "2026-07-10T10:00:00+05:30",
    updatedBy: "Rahul Shah",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "prod_m164",
    name: "Mahek Mild Cleaner M164",
    slug: "mahek-mild-cleaner-m164",
    tag: "Cleaner",
    status: "published",
    displayOrder: 8,
    shortDescription: "Bringing Natural Beauty Back to Wood & Metal.",
    longDescription:
      "A ready-to-use mild cleaner that restores the natural appearance of weathered, gray, and dirty decks — removes mildew, algae, and fungus stains.",
    applications: ["Wood Cleaning", "Metal Cleaning"],
    benefits: ["Fast Drying", "Crystal Clear", "Removes mildew, algae, and fungus stains"],
    packaging: ["1L", "5L", "20L"],
    specs: [{ label: "Appearance", value: "Crystal Clear" }],
    images: [{ id: "m8", label: "164", alt: "Mahek M164 Mild Cleaner" }],
    industries: ["Furniture Shops", "Metal Industries"],
    seo: {
      title: "Mahek Mild Cleaner M164 | Industrial Thinners",
      description: "Bringing natural beauty back to wood and metal.",
      canonical: "/products/mahek-mild-cleaner-m164",
      ogImage: "m8",
    },
    updatedAt: "2026-08-01T13:00:00+05:30",
    updatedBy: "Vikram Doshi",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "prod_enamel",
    name: "Mahek Enamel / G.P. Thinner",
    slug: "enamel-gp-thinner",
    tag: "General Purpose",
    status: "archived",
    displayOrder: 9,
    shortDescription: "Rich Oil-Base Reducing Agent for Premium Enamel & Oil Paint Systems",
    longDescription:
      "A premium oil-based reducing agent specially formulated to provide the required viscosity for enamel and oil paints — ensures smooth flow and uniform film formation. Archived pending a packaging-size re-confirmation.",
    applications: ["Cleaning Spray Guns, Rollers, and Brushes", "Synthetic Enamel", "Oil Primer"],
    benefits: ["Fast Drying", "Glossy Finish", "Low Odor"],
    packaging: ["800ml", "1L", "4L", "5L", "20L"],
    specs: [{ label: "Appearance", value: "Clear liquid" }],
    images: [{ id: "m9", label: "GP", alt: "Mahek Enamel GP Thinner" }],
    industries: ["Decorative Paints", "Hardware Shops", "Industrial Counters"],
    seo: {
      title: "Mahek Enamel / G.P. Thinner | Industrial Thinners",
      description: "Rich oil-base reducing agent for premium enamel & oil paint systems.",
      canonical: "/products/enamel-gp-thinner",
      ogImage: "m9",
    },
    updatedAt: "2026-05-18T09:00:00+05:30",
    updatedBy: "Admin",
  },
];

/* -------------------------------------------------------------- industries */

export const INITIAL_INDUSTRIES: WebsiteIndustry[] = [
  {
    id: "ind_paint",
    name: "Paint Industry",
    slug: "paint-industry",
    status: "published",
    displayOrder: 1,
    shortDescription: "Thinning & reduction solvents for paint manufacturers and formulators.",
    image: "paint-industry.webp",
    productSlugs: ["universal-thinner", "pu-thinner", "nano-thinner"],
    seo: { title: "Paint Industry Solutions", description: "Thinning & reduction solvents for paint manufacturers.", canonical: "/industries/paint-industry" },
    updatedAt: "2026-09-10T10:00:00+05:30",
    updatedBy: "Rahul Shah",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "ind_furniture",
    name: "Furniture Manufacturing",
    slug: "furniture",
    status: "published",
    displayOrder: 2,
    shortDescription: "Fast-drying, high-gloss finishing solvents for wood and furniture coating lines.",
    image: "furniture-manufacturing.webp",
    productSlugs: ["universal-thinner", "pu-thinner", "nc-thinner", "mylac-135-melamine-thinner"],
    seo: { title: "Furniture Manufacturing Solutions", description: "Finishing solvents for wood and furniture coating lines.", canonical: "/industries/furniture" },
    updatedAt: "2026-09-05T10:00:00+05:30",
    updatedBy: "Seema Kulkarni",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "ind_auto",
    name: "Automobile Industry",
    slug: "automobile",
    status: "published",
    displayOrder: 3,
    shortDescription: "Precision thinners for OEM and refinish automotive coating systems.",
    image: "automobile-industry.webp",
    productSlugs: ["universal-thinner", "pu-thinner", "nano-thinner"],
    seo: { title: "Automobile Industry Solutions", description: "Precision thinners for automotive coating systems.", canonical: "/industries/automobile" },
    updatedAt: "2026-08-22T10:00:00+05:30",
    updatedBy: "Rahul Shah",
    publishedAt: "2026-06-01T09:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    id: "ind_cleaning",
    name: "Cleaning Industry",
    slug: "cleaning-industry",
    status: "draft",
    displayOrder: 4,
    shortDescription: "Multi-purpose cleaning solvents for degreasing and surface preparation.",
    image: null,
    productSlugs: ["mahek-mild-cleaner-m164"],
    seo: { title: "", description: "", canonical: "/industries/cleaning-industry" },
    updatedAt: "2026-09-28T10:00:00+05:30",
    updatedBy: "Seema Kulkarni",
  },
];

/* ------------------------------------------------------------------ gallery */

export const INITIAL_GALLERY: GalleryItem[] = [
  { id: "g1", category: "Factory", label: "Ambernath MIDC Plant — Exterior", image: "factory-exterior.jpg", alt: "Ambernath MIDC plant exterior", status: "published", displayOrder: 1, updatedAt: "2026-07-01T10:00:00+05:30", updatedBy: "Admin", publishedAt: "2026-07-01T10:00:00+05:30", publishedBy: "Admin" },
  { id: "g2", category: "Factory", label: "Production Line 1", image: "manufacturing.jpg", alt: "Production line at Ambernath", status: "published", displayOrder: 2, updatedAt: "2026-07-01T10:00:00+05:30", updatedBy: "Admin", publishedAt: "2026-07-01T10:00:00+05:30", publishedBy: "Admin" },
  { id: "g3", category: "Factory", label: "Raw Material Storage Yard", image: "raw-material.jpg", alt: "Raw material storage yard", status: "published", displayOrder: 3, updatedAt: "2026-07-01T10:00:00+05:30", updatedBy: "Admin", publishedAt: "2026-07-01T10:00:00+05:30", publishedBy: "Admin" },
  { id: "g4", category: "Dealer Meet", label: "Annual Dealer Meet 2026", image: "dealer-meet-2026.jpg", alt: "Annual dealer meet", status: "draft", displayOrder: 4, updatedAt: "2026-09-30T10:00:00+05:30", updatedBy: "Vikram Doshi" },
];

/* ------------------------------------------------------------------ careers */

export const INITIAL_JOBS: JobPosting[] = [
  { id: "job1", title: "Production Supervisor", department: "Manufacturing", location: "Ambernath MIDC", type: "Full-time", description: "Oversee daily production line operations, batch quality handoffs and shift scheduling at the Ambernath plant.", status: "open", createdAt: "2026-08-01T10:00:00+05:30", updatedAt: "2026-08-01T10:00:00+05:30", updatedBy: "Admin" },
  { id: "job2", title: "Quality Control Chemist", department: "Laboratory", location: "Ambernath MIDC", type: "Full-time", description: "Run batch testing (specific gravity, flash point, appearance) against technical data sheets before release.", status: "open", createdAt: "2026-08-10T10:00:00+05:30", updatedAt: "2026-08-10T10:00:00+05:30", updatedBy: "Admin" },
  { id: "job3", title: "Area Sales Executive", department: "Sales", location: "Mumbai", type: "Full-time", description: "Develop and manage dealer/distributor relationships across the assigned territory.", status: "open", createdAt: "2026-09-01T10:00:00+05:30", updatedAt: "2026-09-01T10:00:00+05:30", updatedBy: "Rahul Shah" },
  { id: "job4", title: "Logistics Coordinator", department: "Supply Chain", location: "Mumbai", type: "Full-time", description: "Coordinate dispatch scheduling and transport booking across 8+ states.", status: "closed", createdAt: "2026-06-15T10:00:00+05:30", updatedAt: "2026-09-15T10:00:00+05:30", updatedBy: "Admin" },
];

/* ------------------------------------------------------------- testimonials */

export const INITIAL_TESTIMONIALS: Testimonial[] = [
  { id: "t1", name: "Prakash Mehta", role: "Proprietor", company: "Mehta Paints, Pune", quote: "Mahek's consistency batch to batch is why we've stayed with them for over a decade.", initials: "PM", status: "published", displayOrder: 1, updatedAt: "2026-06-01T10:00:00+05:30", updatedBy: "Admin", publishedAt: "2026-06-01T10:00:00+05:30", publishedBy: "Admin" },
  { id: "t2", name: "Sunita Rane", role: "Purchase Manager", company: "Rane Hardware", quote: "Quick delivery and the quality never varies — that matters more to us than price.", initials: "SR", status: "published", displayOrder: 2, updatedAt: "2026-06-05T10:00:00+05:30", updatedBy: "Admin", publishedAt: "2026-06-05T10:00:00+05:30", publishedBy: "Admin" },
  { id: "t3", name: "Deepak Jain", role: "Distributor", company: "Jain Trading Co.", quote: "Their dealer support and margins have let us grow our territory every year.", initials: "DJ", status: "draft", displayOrder: 3, updatedAt: "2026-09-25T10:00:00+05:30", updatedBy: "Seema Kulkarni" },
];

/* --------------------------------------------------------------- milestones */

export const INITIAL_MILESTONES: Milestone[] = [
  { id: "ms1", year: "1995", title: "Foundation of the Company", description: "Melody Chemical was established by Bipin Doshi in Bhandup, Mumbai.", displayOrder: 1 },
  { id: "ms2", year: "2005", title: "Building Our Product Portfolio", description: "Mahek Marketing was established; operations shifted to Bhiwandi.", displayOrder: 2 },
  { id: "ms3", year: "2022", title: "Ambernath MIDC Manufacturing Expansion", description: "Development of the manufacturing facility at Ambernath MIDC.", displayOrder: 3 },
  { id: "ms4", year: "2024", title: "Expanding Across India", description: "Presence established across 8+ states in India.", displayOrder: 4 },
];

/* --------------------------------------------------------------- navigation */

export const INITIAL_NAV: NavItem[] = [
  { id: "n1", group: "header", label: "Home", href: "/", displayOrder: 1, visible: true },
  { id: "n2", group: "header", label: "About", href: "/about", displayOrder: 2, visible: true },
  { id: "n3", group: "header", label: "Products", href: "/products", displayOrder: 3, visible: true },
  { id: "n4", group: "header", label: "Industries", href: "/industries", displayOrder: 4, visible: true },
  { id: "n5", group: "header", label: "Manufacturing & Quality", href: "/manufacturing", displayOrder: 5, visible: true },
  { id: "n6", group: "header", label: "Gallery", href: "/gallery", displayOrder: 6, visible: true },
  { id: "n7", group: "header", label: "Distributor", href: "/distributor", displayOrder: 7, visible: true },
  { id: "n8", group: "header", label: "Career", href: "/career", displayOrder: 8, visible: true },
  { id: "n9", group: "header", label: "Contact", href: "/contact", displayOrder: 9, visible: true },
  { id: "n10", group: "footer-company", label: "About Us", href: "/about", displayOrder: 1, visible: true },
  { id: "n11", group: "footer-company", label: "Manufacturing", href: "/manufacturing", displayOrder: 2, visible: true },
  { id: "n12", group: "footer-company", label: "Quality", href: "/quality", displayOrder: 3, visible: true },
  { id: "n13", group: "footer-quick", label: "Become a Distributor", href: "/distributor", displayOrder: 1, visible: true },
  { id: "n14", group: "footer-quick", label: "Career", href: "/career", displayOrder: 2, visible: true },
  { id: "n15", group: "footer-legal", label: "Privacy Policy", href: "/privacy-policy", displayOrder: 1, visible: true },
  { id: "n16", group: "footer-legal", label: "Terms & Conditions", href: "/terms-and-conditions", displayOrder: 2, visible: true },
  { id: "n17", group: "manufacturing-mega", label: "Manufacturing Facility", href: "/manufacturing", displayOrder: 1, visible: true },
  { id: "n18", group: "manufacturing-mega", label: "Quality Control", href: "/quality", displayOrder: 2, visible: true },
];

/* -------------------------------------------------------------------- media */

export const INITIAL_MEDIA: MediaAsset[] = [
  { id: "med1", filename: "universal-thinner-combo.webp", alt: "Mahek Universal Thinner Combo pack", contentType: "image/webp", sizeKb: 182, width: 1200, height: 1200, uploadedAt: "2026-06-01T09:00:00+05:30", uploadedBy: "Admin", usedBy: ["Product: Mahek Universal Thinner"] },
  { id: "med2", filename: "nc-thinner-combo.webp", alt: "Mahek NC Thinner Combo pack", contentType: "image/webp", sizeKb: 164, width: 1200, height: 1200, uploadedAt: "2026-06-01T09:00:00+05:30", uploadedBy: "Admin", usedBy: ["Product: Mahek NC Thinner"] },
  { id: "med3", filename: "ambernath-plant-exterior.jpg", alt: "Ambernath MIDC plant exterior", contentType: "image/jpeg", sizeKb: 890, width: 1920, height: 1280, uploadedAt: "2026-07-01T10:00:00+05:30", uploadedBy: "Admin", usedBy: ["Gallery: Ambernath MIDC Plant — Exterior"] },
  { id: "med4", filename: "og-image-default.jpg", alt: "Mahek Marketing India — manufacturing facility", contentType: "image/jpeg", sizeKb: 240, width: 1200, height: 630, uploadedAt: "2026-06-01T09:00:00+05:30", uploadedBy: "Admin", usedBy: ["Settings: Default OG image"] },
  { id: "med5", filename: "dealer-meet-2026.jpg", alt: "Annual dealer meet 2026", contentType: "image/jpeg", sizeKb: 610, width: 1600, height: 1067, uploadedAt: "2026-09-30T09:40:00+05:30", uploadedBy: "Vikram Doshi", usedBy: [] },
];

/* -------------------------------------------------------------------- pages */

export const INITIAL_PAGES: WebsitePage[] = [
  {
    key: "about",
    name: "About",
    route: "/about",
    status: "published",
    sections: [
      { key: "hero", label: "Hero", fields: [
        { key: "heading", label: "Heading", type: "text", value: "About Mahek Marketing India" },
        { key: "sub", label: "Subtext", type: "textarea", value: "31+ years of manufacturing discipline behind every material we dispatch." },
      ]},
      { key: "story", label: "Company Story", fields: [
        { key: "p1", label: "Paragraph 1", type: "textarea", value: "Mahek Marketing India began as a small thinner blending operation in Mumbai, built on a simple premise: dealers and industrial buyers deserve consistent quality at a fair price, every single time." },
        { key: "p2", label: "Paragraph 2", type: "textarea", value: "Today, our Ambernath MIDC facility manufactures 15 tons of industrial thinners and specialty solvents daily, serving 1190+ customers across 8+ Indian states." },
      ]},
      { key: "stats", label: "Company Stats", fields: [
        { key: "customers", label: "Active Customers", type: "text", value: "1190+" },
        { key: "capacity", label: "Production Capacity", type: "text", value: "15 TPD" },
      ]},
      { key: "cta", label: "CTA", fields: [
        { key: "label", label: "Button Label", type: "text", value: "Explore Manufacturing" },
        { key: "href", label: "Button Link", type: "text", value: "/manufacturing" },
      ]},
    ],
    seo: { title: "About Us", description: "31+ years of manufacturing discipline behind every material we dispatch.", canonical: "/about" },
    updatedAt: "2026-09-18T10:00:00+05:30",
    updatedBy: "Admin",
    publishedAt: "2026-09-18T10:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    key: "manufacturing",
    name: "Manufacturing & Quality",
    route: "/manufacturing",
    status: "published",
    sections: [
      { key: "hero", label: "Hero", fields: [
        { key: "heading", label: "Heading", type: "text", value: "Manufacturing Facility" },
        { key: "sub", label: "Subtext", type: "textarea", value: "A look inside our Ambernath MIDC plant — from raw material intake to final dispatch." },
      ]},
      { key: "facility", label: "Facility Information", fields: [
        { key: "location", label: "Plant Location", type: "text", value: "Ambernath, Maharashtra" },
        { key: "established", label: "Established", type: "text", value: "2014" },
      ]},
      { key: "process", label: "Manufacturing Process", fields: [
        { key: "steps", label: "Process summary", type: "textarea", value: "Raw Material Intake → Laboratory Testing → Production Line → Quality Control → Packaging → Dispatch." },
      ]},
      { key: "capacity", label: "Capacity", fields: [
        { key: "daily", label: "Daily Production", type: "text", value: "15 TPD" },
      ]},
      { key: "quality", label: "Quality / Safety", fields: [
        { key: "cert", label: "Certification", type: "text", value: "ISO 9001 Certified Process" },
      ]},
      { key: "cta", label: "CTA", fields: [
        { key: "label", label: "Button Label", type: "text", value: "Request a Quote" },
      ]},
    ],
    seo: { title: "Manufacturing Facility", description: "A look inside our Ambernath MIDC plant.", canonical: "/manufacturing" },
    updatedAt: "2026-09-10T10:00:00+05:30",
    updatedBy: "Admin",
    publishedAt: "2026-09-10T10:00:00+05:30",
    publishedBy: "Admin",
  },
  {
    key: "quality",
    name: "Quality",
    route: "/quality",
    status: "published",
    sections: [
      { key: "hero", label: "Hero", fields: [{ key: "heading", label: "Heading", type: "text", value: "Manufacturing & Quality Assurance" }] },
    ],
    seo: { title: "Quality Assurance", description: "Every batch passes through a multi-stage inspection process.", canonical: "/quality" },
    updatedAt: "2026-08-01T10:00:00+05:30",
    updatedBy: "Admin",
  },
  {
    key: "distributor",
    name: "Distributor",
    route: "/distributor",
    status: "published",
    sections: [
      { key: "hero", label: "Hero", fields: [{ key: "heading", label: "Heading", type: "text", value: "Become a Distributor" }] },
      { key: "faqs", label: "FAQs", fields: [{ key: "note", label: "Note", type: "textarea", value: "FAQ entries are managed as a list below the standard fields." }] },
    ],
    seo: { title: "Become a Distributor", description: "Join a growing network of 100+ dealers across India.", canonical: "/distributor" },
    updatedAt: "2026-07-20T10:00:00+05:30",
    updatedBy: "Admin",
  },
  {
    key: "contact",
    name: "Contact",
    route: "/contact",
    status: "published",
    sections: [
      { key: "hero", label: "Hero", fields: [{ key: "heading", label: "Heading", type: "text", value: "Contact Us" }] },
      { key: "info", label: "Contact Info", fields: [
        { key: "office", label: "Registered Office", type: "textarea", value: "C/602, Sai Srishti, LBS Marg, Bhandup West, Mumbai 400078" },
        { key: "plant", label: "Manufacturing Plant", type: "textarea", value: "Plot No. M30, Pale MIDC, Ambernath East - 421506" },
      ]},
    ],
    seo: { title: "Contact Us", description: "Reach our sales team, visit our office or plant.", canonical: "/contact" },
    updatedAt: "2026-09-01T10:00:00+05:30",
    updatedBy: "Admin",
  },
];

/* ----------------------------------------------------------------- settings */

export const INITIAL_SETTINGS = {
  company: {
    name: "Mahek Marketing India",
    phone: "+91 81081 06253",
    email: "info@mahekindia.com",
    officeAddress: "Mumbai, Maharashtra, India",
    plantAddress: "Ambernath MIDC, Maharashtra, India",
  },
  stats: {
    happyCustomers: "1190+",
    dailyProduction: "15 T",
    statesServed: "8+",
    distributorNetwork: "100+",
    yearsExperience: "31+",
  },
  social: {
    linkedin: "",
    facebook: "",
    instagram: "",
    youtube: "",
  },
  contact: {
    phone: "+91 81081 06253",
    whatsapp: "+91 81081 06253",
    email: "info@mahekindia.com",
    workingHours: "Mon–Sat, 9:30–6:30",
  },
  analytics: {
    gaMeasurementId: "G-9QL6FEYDRC",
  },
  seoDefaults: {
    siteTitle: "Mahek Marketing India | Industrial Thinners & Specialty Solvents",
    defaultDescription:
      "Manufacturer of premium industrial thinners, solvents, paint removers and specialty chemical products. Trusted by 1190+ customers across 8+ Indian states.",
    defaultOgImage: "med4",
    indexable: true,
  },
};

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
