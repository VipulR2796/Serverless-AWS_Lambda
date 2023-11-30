const AWS = require('aws-sdk');
const mailgun = require('mailgun-js');
const dotenv = require('dotenv').config();
AWS.config.update({ region: process.env.REGION });
const sns = new AWS.SNS();
const dynamodb = new AWS.DynamoDB.DocumentClient();

const fs = require('fs').promises;
const download = require('download');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const uuid = require('uuid');

exports.handler = async (event, context) => {
  console.log('Lambda function invoked');
  const bucket = process.env.GOOGLE_CLOUD_BUCKET_NAME;
  const dynamoDB = process.env.DYNAMODB_TABLE_NAME;
  const sourceEmail =  "mailgun@cloudneu.me";

  const credentialsBase64 = process.env.SERVICE_ACCOUNT_KEY;
  const credentialsJSON = Buffer.from(credentialsBase64, 'base64').toString('utf-8');
  const storage = new Storage({
    credentials: JSON.parse(credentialsJSON),
    projectId: process.env.GOOGLE_PROJECT_ID
  });


  try {
    // Parse SNS message
    const snsMessage = JSON.parse(event.Records[0].Sns.Message);
    const email = snsMessage.user_email;
    const githubRepoUrl = snsMessage.submission_url;
    const emailDetails = {
      email: email,
      submissionURL: githubRepoUrl,
      gcsURL: '',
      emailSentTime: '',
      assignmentId: snsMessage.assignment_id,
      status: ''
    };

    // Download GitHub repo as a zip file
    let zipFile;
    // Upload zip file to Google Cloud Storage
    let googleStorageUrl;
    let emailSent;
    
    zipFile = await downloadGitHubRepo(email, githubRepoUrl);
    if (zipFile.error) {
      console.log('zipfile not found: ', zipFile);
      emailDetails.status = 'failed';
      emailDetails.gcsURL = 'null';
      emailSent = await sendEmail(email, sourceEmail, 'Submission Unsuccessful', `Error: ${zipFile.error}`, dynamoDB, emailDetails);
      return zipFile.error;
    } else {
      console.log('zipfile found', zipFile);
      // If successfully downloaded, upload to Google Cloud Storage
      googleStorageUrl = await uploadToGoogleStorage(bucket, storage, zipFile, email);
      if (googleStorageUrl.error) {
        emailDetails.status = 'failed';
        emailDetails.gcsURL = 'null';
        emailSent = await sendEmail(email, sourceEmail, 'Submission Unsuccessful', 'Error: Could not upload zip file. Try again!', dynamoDB, emailDetails);
        return googleStorageUrl.error;
      }

      // If successfully uploaded, send success email
      emailDetails.status = 'success';
      emailDetails.gcsURL = googleStorageUrl.utilURL;
      emailDetails.authenticatedURL = googleStorageUrl.authenticatedURL;
      emailSent = await sendEmail(email, sourceEmail, 'Submission Successful', 'Your submission was successful.', dynamoDB, emailDetails);
      return `Successfully processed ${githubRepoUrl} for ${email}`;
    }
  } catch (error) {
    console.error('Error:', error);
    return error; // Re-throw the error to propagate it further
  }
};

const downloadGitHubRepo = async (email, githubRepoUrl) => {
  try {
    const tempDir = '/tmp';
    const url = githubRepoUrl;

    // Check if the URL ends with '.zip'
    if (!url.toLowerCase().endsWith('.zip')) {
      return {
        error: 'Invalid GitHub repository URL. It must be a link to a zip file.'
      };
    }

    // Download the buffer
    let buffer = await download(url);

    // Generate a unique file name
    const fileName = `${email}_${Date.now()}.zip`;
    const zipFilePath = `${tempDir}/${fileName}`;

    // Save the buffer to a file
    await fs.writeFile(zipFilePath, buffer, 'binary');
    console.log('Downloaded GitHub repo:', zipFilePath);

    // Check if the '.zip' did not download
    if (!zipFilePath) {
      return {
        error: 'Invalid URL or Zip file.'
      };
    }
    // Return the path of the saved file
    return zipFilePath;
  } catch (error) {
    console.error('Error downloading GitHub repo:', error);
    return {
      error: 'Invalid URL or Zip file.'
    }; 
  }
};

const uploadToGoogleStorage = async (bucketName, storage, filePath, email) => {
  try {
    console.log('Uploading to Google Cloud Storage');
    const bucket = storage.bucket(bucketName);
    const currentDateTime = new Date().toISOString().replace(/:/g, '-');
    const destinationFileName = `${email}_${currentDateTime}.zip`;

    // Use the upload method to directly upload the file
    await bucket.upload(filePath, {
      destination: destinationFileName,
      metadata: {
        contentType: 'application/zip', // Set the content type based on your file type
      },
    });

    console.log('Upload to Google Cloud Storage finished');
    return {
      authenticatedURL: `storage.cloud.google.com/${bucketName}/${destinationFileName}`.replace(/@/g, '%40'),
      utilURL: `gs://${bucketName}/${destinationFileName}`,
    };
  } catch (error) {
    console.error('Error uploading to Google Cloud Storage:', error);
    return {
      error: error
    };
  }
};

/*
const sendEmail = async (toEmail, sourceEmail, subject, message, dynamoDB, emailDetails) => {
  try {
    console.log('Sending email', toEmail, sourceEmail, subject, message);
    if (emailDetails.status == 'success') message += ` \n\nGCS UTIL URL: ${emailDetails.gcsURL} \n\nGCS URL: ${emailDetails.authenticatedURL}`;
    const emailParams = {
      Destination: {
        ToAddresses: [toEmail],
      },
      Message: {
        Body: {
          Text: {
            Charset: 'UTF-8',
            Data: message,
          },
        },
        Subject: {
          Charset: 'UTF-8',
          Data: subject,
        },
      },
      Source: sourceEmail,
    };
    
    const result = await ses.sendEmail(emailParams).promise();
    console.log('Email sent successfully:', result);

    // Saving EMAIL DETAILS to DB
    // Generate a random UUID
    const randomUUID = uuid.v4();
    emailDetails.id = randomUUID;
    let date = new Date().toISOString();
    emailDetails.emailSentTime = date;
    console.log('Saving in dynamo db', emailDetails);
    const dbParams = {
      TableName: dynamoDB,
      Item: emailDetails,
    };
    
    const data = await dynamodb.put(dbParams).promise();
    console.log('Saved to dynamo db', dbParams);
    return result;
  } catch (error) {
    console.error('Error sending email:', error);
    return error;
  }
};
*/

const sendEmail = async (toEmail, sourceEmail, subject, message, emailDetails) => {
    try {
      console.log('Sending email', toEmail, sourceEmail, subject, message);
  
      const mg = mailgun({
        apiKey: process.env.MAILGUN_API_KEY,
        domain: process.env.MAILGUN_DOMAIN,
      });
  
      const emailData = {
        from: sourceEmail,
        to: toEmail,
        subject: subject,
        text: message,
      };
  
      const result = await mg.messages().send(emailData);
      console.log('Email sent successfully:', result);
  
      // Saving EMAIL DETAILS to DB
      // Generate a random UUID
      const randomUUID = uuid.v4();
      emailDetails.id = randomUUID;
      let date = new Date().toISOString();
      emailDetails.emailSentTime = date;
      console.log('Saving in dynamo db', emailDetails);
      const dbParams = {
        TableName: emailDetails.dynamoDB,
        Item: emailDetails,
      };
  
      const data = await dynamodb.put(dbParams).promise();
      console.log('Saved to dynamo db', dbParams);
      return result;
    } catch (error) {
      console.error('Error sending email:', error);
      return error;
    }
  };
