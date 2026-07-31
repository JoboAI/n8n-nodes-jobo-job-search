import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class JoboApi implements ICredentialType {
  name = "joboApi";

  displayName = "Jobo API";

  documentationUrl = "https://jobo.world/integrations/n8n";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description:
        'Your Jobo API key. Starts with "jbe_live_" or "jbe_test_". Create one at https://enterprise.jobo.world/api-keys.',
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://connect.jobo.world",
      description: "Only change this if Jobo support has given you a different endpoint",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        "X-Api-Key": "={{$credentials.apiKey}}",
      },
    },
  };

  // page_size=1 keeps the credential test as cheap as the API allows: the
  // balance precheck prices the requested page size, so a larger probe would
  // demand a bigger balance to verify a key.
  test: ICredentialTestRequest = {
    request: {
      baseURL: "={{$credentials.baseUrl}}",
      url: "/api/jobs",
      method: "GET",
      qs: { page_size: 1 },
    },
  };
}
