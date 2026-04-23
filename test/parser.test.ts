import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { loadSpec } from '../src/parser/loader.js'
import { resolveSpec } from '../src/parser/resolver.js'

const FIXTURE = resolve(import.meta.dirname, 'fixtures/petstore.yaml')

describe('loader', () => {
  it('loads a YAML file', async () => {
    const doc = await loadSpec(FIXTURE)
    expect(doc.openapi).toBe('3.0.3')
    expect(doc.info.title).toBe('Petstore')
  })

  it('loads inline JSON string', async () => {
    const json = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {},
    })
    const doc = await loadSpec(json)
    expect(doc.info.title).toBe('Test')
  })

  it('loads inline object', async () => {
    const doc = await loadSpec({
      openapi: '3.0.3',
      info: { title: 'Inline', version: '1.0.0' },
      paths: {},
    })
    expect(doc.info.title).toBe('Inline')
  })
})

describe('resolver', () => {
  it('parses the petstore spec', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(spec.title).toBe('Petstore')
    expect(spec.version).toBe('1.0.0')
    expect(spec.servers).toHaveLength(3)
    expect(spec.servers[0].url).toBe('https://petstore.example.com/v1')
    expect(spec.servers[0].description).toBe('Production')
    expect(spec.servers[1].url).toBe('https://sandbox.petstore.example.com/v1')
    expect(spec.servers[1].description).toBe('Sandbox')
  })

  it('extracts all operations', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(spec.operations).toHaveLength(5)

    const ids = spec.operations.map((op) => op.operationId)
    expect(ids).toContain('listPets')
    expect(ids).toContain('createPet')
    expect(ids).toContain('getPetById')
    expect(ids).toContain('deletePet')
    expect(ids).toContain('uploadPetImage')
  })

  it('parses parameters correctly', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const listPets = spec.operations.find((op) => op.operationId === 'listPets')!
    expect(listPets.parameters).toHaveLength(3)

    const limitParam = listPets.parameters.find((p) => p.name === 'limit')!
    expect(limitParam.in).toBe('query')
    expect(limitParam.required).toBe(false)
    expect(limitParam.schema.type).toBe('integer')
  })

  it('parses request body', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const createPet = spec.operations.find((op) => op.operationId === 'createPet')!
    expect(createPet.requestBody).toBeDefined()
    expect(createPet.requestBody!.required).toBe(true)
    expect(createPet.requestBody!.content['application/json']).toBeDefined()
  })

  it('extracts schemas', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(Object.keys(spec.schemas)).toContain('Pet')
    expect(Object.keys(spec.schemas)).toContain('NewPet')
    expect(spec.schemas['Pet'].required).toContain('id')
  })

  it('extracts security schemes', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(Object.keys(spec.securitySchemes)).toContain('bearerAuth')
    expect(Object.keys(spec.securitySchemes)).toContain('apiKeyAuth')
    expect(spec.securitySchemes['bearerAuth'].type).toBe('http')
  })

  it('extracts parameter examples', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const listPets = spec.operations.find((op) => op.operationId === 'listPets')!
    const limitParam = listPets.parameters.find((p) => p.name === 'limit')!
    expect(limitParam.example).toBe(10)

    const getPet = spec.operations.find((op) => op.operationId === 'getPetById')!
    const petIdParam = getPet.parameters.find((p) => p.name === 'petId')!
    expect(petIdParam.example).toBe(123)
  })

  it('extracts deprecated flags on operations', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const deletePet = spec.operations.find((op) => op.operationId === 'deletePet')!
    expect(deletePet.deprecated).toBe(true)

    const listPets = spec.operations.find((op) => op.operationId === 'listPets')!
    expect(listPets.deprecated).toBeUndefined()
  })

  it('extracts deprecated flags on parameters', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const listPets = spec.operations.find((op) => op.operationId === 'listPets')!
    const offset = listPets.parameters.find((p) => p.name === 'offset')!
    expect(offset.deprecated).toBe(true)

    const limit = listPets.parameters.find((p) => p.name === 'limit')!
    expect(limit.deprecated).toBeUndefined()
  })

  it('extracts response schemas', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const getPet = spec.operations.find((op) => op.operationId === 'getPetById')!
    const resp200 = getPet.responses['200']
    expect(resp200.schema).toBeDefined()
    expect(resp200.schema!.type).toBe('object')
    expect(resp200.schema!.properties).toHaveProperty('name')

    const resp404 = getPet.responses['404']
    expect(resp404.schema).toBeDefined()
    expect(resp404.schema!.type).toBe('object')
    expect(resp404.schema!.properties).toHaveProperty('code')
    expect(resp404.schema!.properties).toHaveProperty('message')
  })

  it('extracts response examples', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const listPets = spec.operations.find((op) => op.operationId === 'listPets')!
    const resp200 = listPets.responses['200']
    expect(resp200.example).toBeDefined()
    expect(Array.isArray(resp200.example)).toBe(true)

    const createPet = spec.operations.find((op) => op.operationId === 'createPet')!
    const resp201 = createPet.responses['201']
    expect(resp201.example).toBeDefined()
    expect((resp201.example as any).id).toBe(42)
  })

  it('extracts response links', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const createPet = spec.operations.find((op) => op.operationId === 'createPet')!
    const resp201 = createPet.responses['201']
    expect(resp201.links).toBeDefined()
    expect(resp201.links!['GetCreatedPet']).toBeDefined()
    expect(resp201.links!['GetCreatedPet'].operationId).toBe('getPetById')
    expect(resp201.links!['GetCreatedPet'].parameters).toEqual({ petId: '$response.body#/id' })
    expect(resp201.links!['GetCreatedPet'].description).toBe('Retrieve the pet that was just created')

    expect(resp201.links!['UploadCreatedPetImage']).toBeDefined()
    expect(resp201.links!['UploadCreatedPetImage'].operationId).toBe('uploadPetImage')

    const getPet = spec.operations.find((op) => op.operationId === 'getPetById')!
    const resp200 = getPet.responses['200']
    expect(resp200.links).toBeDefined()
    expect(resp200.links!['DeleteThisPet'].operationId).toBe('deletePet')
  })

  it('extracts request body examples', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const createPet = spec.operations.find((op) => op.operationId === 'createPet')!
    const jsonContent = createPet.requestBody!.content['application/json']
    expect(jsonContent.example).toBeDefined()
    expect(jsonContent.example).toEqual({ name: 'Buddy', tag: 'dog' })
  })

  it('preserves response content for http/client compatibility', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const listPets = spec.operations.find((op) => op.operationId === 'listPets')!
    const resp200 = listPets.responses['200']
    expect(resp200.content).toBeDefined()
    expect(resp200.content!['application/json']).toBeDefined()
    expect(resp200.content!['application/json'].schema).toBeDefined()
  })

  it('extracts Error schema', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(Object.keys(spec.schemas)).toContain('Error')
    expect(spec.schemas['Error'].required).toContain('code')
    expect(spec.schemas['Error'].required).toContain('message')
  })

  it('extracts multiple servers with descriptions and variables', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(spec.servers).toHaveLength(3)
    expect(spec.servers[0]).toEqual({
      url: 'https://petstore.example.com/v1',
      description: 'Production',
    })
    expect(spec.servers[1]).toEqual({
      url: 'https://sandbox.petstore.example.com/v1',
      description: 'Sandbox',
    })
    expect(spec.servers[2].url).toBe('https://{environment}.petstore.example.com/{version}')
    expect(spec.servers[2].description).toBe('Custom environment')
    expect(spec.servers[2].variables).toBeDefined()
    expect(spec.servers[2].variables!['environment']).toEqual({
      enum: ['dev', 'staging', 'prod'],
      default: 'prod',
      description: 'Target environment',
    })
    expect(spec.servers[2].variables!['version']).toEqual({
      default: 'v1',
      description: 'API version',
    })
  })

  it('extracts global tags with descriptions and externalDocs', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(spec.tags).toHaveLength(2)
    expect(spec.tags[0]).toEqual({
      name: 'pets',
      description: 'Everything about your Pets',
      externalDocs: {
        url: 'https://docs.petstore.example.com/pets',
        description: 'Pets documentation',
      },
    })
    expect(spec.tags[1]).toEqual({
      name: 'store',
      description: 'Access to Petstore orders',
    })
  })

  it('extracts root-level externalDocs', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    expect(spec.externalDocs).toEqual({
      url: 'https://docs.petstore.example.com',
      description: 'Full Petstore documentation',
    })
  })

  it('extracts operation-level externalDocs', async () => {
    const doc = await loadSpec(FIXTURE)
    const spec = await resolveSpec(doc)

    const getPet = spec.operations.find((op) => op.operationId === 'getPetById')!
    expect(getPet.externalDocs).toEqual({
      url: 'https://docs.petstore.example.com/pets/get',
      description: 'Detailed get pet docs',
    })

    const listPets = spec.operations.find((op) => op.operationId === 'listPets')!
    expect(listPets.externalDocs).toBeUndefined()
  })
})
