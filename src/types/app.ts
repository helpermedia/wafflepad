export interface AppInfo {
  name: string;
  path: string;
  icon: string | null;
  /** App Store category identifier (LSApplicationCategoryType), if declared */
  category: string | null;
}

export interface FolderInfo {
  name: string;
  path: string;
  apps: AppInfo[];
}

export interface FolderMetadata {
  id: string;
  name: string;
  appPaths: string[];
  createdAt: number;
}

export interface AppsResponse {
  apps: AppInfo[];
  folders: FolderInfo[];
  /** Directories that exist but failed to read in this scan: apps under
   *  them are unverified, not gone (see healFolders) */
  unreadableDirs: string[];
}

export interface OrderConfig {
  /** Main grid as explicit pages: each inner list is one page's items in order */
  pages: string[][];
  folders: FolderMetadata[];
}

/** How the main grid presents apps */
export type LayoutMode = "scroll" | "paged";

export interface AppSettings {
  layout: LayoutMode;
}

export interface DndSettings {
  /** How long to hold over an app before folder creation ring appears (ms) */
  folderCreationDelay: number;
  /** Minimum overlap ratio (0-1) required for folder creation highlight */
  overlapThreshold: number;
}

export interface AppConfig {
  version: number;
  order: OrderConfig;
  settings: AppSettings;
}
