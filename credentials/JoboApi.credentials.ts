import type {
  IAuthenticateGeneric,
  Icon,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class JoboApi implements ICredentialType {
  name = "joboApi";

  displayName = "Jobo API";

  // Resolved relative to this file — by the verification lint against the
  // source, and by n8n against the compiled copy in dist/credentials/, which
  // scripts/copy-icons.mjs puts there. Hence credentials/jobo.svg exists
  // alongside nodes/Jobo/jobo.svg; copy-icons.mjs fails the build if the two
  // ever drift apart.
  icon: Icon = { light: "file:jobo.svg", dark: "file:jobo-dark.svg" };

  // The setup guide, not the marketing page: this link is what n8n puts behind
  // the "Docs" button on the credential dialog, so it should land on install +
  // filter + troubleshooting steps rather than a product pitch.
  documentationUrl = "https://jobo.world/docs/connectors/n8n";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      // Rendered as HTML by n8n, so these are real links rather than text a
      // user has to retype. The sign-up step is deliberate: every other Jobo
      // doc links straight to the api-keys page, which is a dead end for
      // someone who does not have an account yet.
      description:
        'Your Jobo API key — starts with "jbe_live_" or "jbe_test_". Create one at <a href="https://enterprise.jobo.world/api-keys" target="_blank">enterprise.jobo.world/api-keys</a>. No Jobo account yet? <a href="https://enterprise.jobo.world/register" target="_blank">Sign up free</a> first — the $5 free starting balance is enough to try the node.',
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
