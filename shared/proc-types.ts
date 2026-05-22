export type ProcessSnapshot = {
  pid: number;
  exe: string;
  comm: string;
};

export type ProcsResponse = {
  capturedAt: number;
  processes: ProcessSnapshot[];
};
