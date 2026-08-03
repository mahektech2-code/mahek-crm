CREATE TABLE "complaint_images" (
	"id" text PRIMARY KEY NOT NULL,
	"complaint_id" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "request_cn" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "bill_id" text;--> statement-breakpoint
ALTER TABLE "complaints" ADD COLUMN "goods_description" text;--> statement-breakpoint
ALTER TABLE "complaint_images" ADD CONSTRAINT "complaint_images_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;