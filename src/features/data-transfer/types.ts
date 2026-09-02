export type ImportConflictPolicy = "skip" | "overwrite";

export type ImportPreviewItem = {
  index: number;
  productCode: string;
  warnings?: string[];
  fieldErrors?: Record<string, string[]>;
};

export type ImportPreview = {
  previewToken: string;
  expiresAt: string;
  creates: ImportPreviewItem[];
  conflicts: ImportPreviewItem[];
  invalid: ImportPreviewItem[];
  warnings: string[];
};

export type ImportReport = {
  created: number;
  overwritten: number;
  skipped: number;
  invalid: number;
};

export type ExportDownload = { blob: Blob; filename: string };
