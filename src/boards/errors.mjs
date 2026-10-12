export class BoardError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'BoardError'
    this.status = status
  }
}
