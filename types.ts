
export interface LegalProcess {
  foro: string;
  processo: string;
}

export interface GroupedProcesses {
  [foro: string]: string[];
}

export interface ExtractionResult {
  processes: LegalProcess[];
}

export interface WorkspaceFile {
  id: string;
  name: string;
  blob: Blob;
  pageCount: number;
  status: 'idle' | 'processing' | 'completed' | 'error';
  selected: boolean;
  results?: GroupedProcesses;
}

export interface HistoryItem {
  id: string;
  name: string;
  timestamp: number;
  results: GroupedProcesses;
}
