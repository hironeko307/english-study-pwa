import { storageService } from "./storageService.js";

export class SubmissionService {
  constructor(studentId) {
    this.studentId = studentId;
  }

  getEndpoint() {
    return storageService.legacy.getGasEndpoint().trim();
  }

  setEndpoint(endpoint) {
    storageService.legacy.setGasEndpoint(endpoint);
  }

  getPending() {
    return storageService.legacy.loadPendingSubmissions(this.studentId);
  }

  async enqueue(record) {
    const pending = this.getPending();
    pending.push(record);
    storageService.legacy.savePendingSubmissions(this.studentId, pending);
    await this.flush();
  }

  async flush() {
    const endpoint = this.getEndpoint();
    const pending = this.getPending();

    if (!endpoint || pending.length === 0) {
      return { sent: 0, pending: pending.length };
    }

    await postRecords(endpoint, pending);
    storageService.legacy.savePendingSubmissions(this.studentId, []);
    return { sent: pending.length, pending: 0 };
  }
}

async function postRecords(endpoint, records) {
  const payload = { records };

  await fetch(endpoint, {
    method: "POST",
    mode: "no-cors",
    cache: "no-store",
    keepalive: true,
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });
}
