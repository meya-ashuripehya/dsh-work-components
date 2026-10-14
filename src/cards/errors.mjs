export class CardError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'CardError'
    this.status = status
  }
}
