declare module 'koffi' {
  type KoffiCallback = (...args: any[]) => any

  interface KoffiLibrary {
    func(signature: string): any
    func(name: string, returnType: string, argTypes?: any[]): any
  }

  interface KoffiModule {
    load(path: string): KoffiLibrary
    proto(signature: string): unknown
    pointer(value: unknown): unknown
    register(callback: KoffiCallback, pointerType: unknown): unknown
    unregister(callback: unknown): void
  }

  const koffi: KoffiModule
  export default koffi
}
