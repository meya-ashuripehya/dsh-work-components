export class ProfileError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'ProfileError'
    this.status = status
  }
}
